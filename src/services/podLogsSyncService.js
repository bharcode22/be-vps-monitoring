const { Client } = require('pg');
const net = require('net');
const { dbAsync } = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');
const { decrypt } = require('../utils/crypto');

const POD_DB_USER = process.env.POD_DB_USER || 'development';
const POD_DB_PASS = process.env.POD_DB_PASS || 'development';
const POD_DB_NAME = process.env.POD_DB_NAME || 'regenesis';
const POD_DB_PORT = parseInt(process.env.POD_DB_PORT || '5432', 10);

/**
 * Fast TCP connection probe
 */
function checkTcpConnection(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    if (!host) return resolve(false);
    const socket = new net.Socket();
    let isResolved = false;

    socket.setTimeout(timeout);
    socket.on('connect', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(true);
      }
    });

    socket.on('timeout', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('error', () => {
      if (!isResolved) {
        isResolved = true;
        socket.destroy();
        resolve(false);
      }
    });

    socket.connect(port || 5432, host);
  });
}

/**
 * Build PostgreSQL connection string for a POD host
 */
function getPodDbUrl(host) {
  const encUser = encodeURIComponent(POD_DB_USER);
  const encPass = encodeURIComponent(POD_DB_PASS);
  return `postgresql://${encUser}:${encPass}@${host}:${POD_DB_PORT}/${POD_DB_NAME}?schema=public`;
}

/**
 * Build Master DB Client
 */
function createMasterClient(masterRecord) {
  const host = masterRecord.host || 'localhost';
  const isCloudDb = host.includes('rds.amazonaws.com') || host.includes('neon.tech') || host.includes('supabase');
  const user = masterRecord.db_user || 'postgres';
  const pass = decrypt(masterRecord.password) || '';
  const port = masterRecord.port || 5432;
  const dbName = masterRecord.db_name || 'postgres';

  return new Client({
    user,
    password: pass,
    host,
    port,
    database: dbName,
    ssl: isCloudDb ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 90000
  });
}

/**
 * Audit pod_logs between Master DB and all POD V3 servers
 */
async function getPodLogsAudit(masterId, targetPodIds = []) {
  if (!masterId) {
    throw new Error('masterId harus disertakan.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) {
    throw new Error('Master DB tidak ditemukan.');
  }

  let masterTotalRows = 0;
  let masterLatestCreated = null;
  let masterClient = null;
  const masterPodCountMap = {};

  try {
    masterClient = createMasterClient(master);
    await masterClient.connect();

    const countRes = await masterClient.query('SELECT COUNT(*) as cnt, MAX(created_at) as latest_created FROM public.pod_logs;');
    if (countRes.rows.length > 0) {
      masterTotalRows = parseInt(countRes.rows[0].cnt, 10) || 0;
      masterLatestCreated = countRes.rows[0].latest_created;
    }

    // Query breakdown count in Master for each POD (grouped by pod_id)
    try {
      const breakdownRes = await masterClient.query('SELECT pod_id, COUNT(*) as cnt FROM public.pod_logs WHERE pod_id IS NOT NULL GROUP BY pod_id;');
      for (const r of breakdownRes.rows) {
        if (r.pod_id) {
          masterPodCountMap[r.pod_id] = parseInt(r.cnt, 10) || 0;
        }
      }
    } catch (bErr) {
      console.warn('Could not query pod_id breakdown from Master:', bErr.message);
    }

    // Fetch ONLY POD V3 servers (including pod_uuid)
    let sqlPods = "SELECT id, name, host, port, username, password, private_key, auth_type, code, pod_version, pod_uuid FROM servers WHERE LOWER(pod_version) = 'v3'";
    const params = [];
    if (Array.isArray(targetPodIds) && targetPodIds.length > 0) {
      const placeholders = targetPodIds.map(() => '?').join(',');
      sqlPods += ` AND id IN (${placeholders})`;
      params.push(...targetPodIds);
    }
    sqlPods += " ORDER BY name ASC;";

    const podServers = await dbAsync.all(sqlPods, params);

    // Query each POD in parallel with controlled concurrency
    const podAuditPromises = podServers.map(async (pod) => {
      const masterRowsForPod = pod.pod_uuid ? (masterPodCountMap[pod.pod_uuid] || 0) : 0;

      const podAudit = {
        id: pod.id,
        name: pod.name,
        code: pod.code,
        host: pod.host,
        pod_uuid: pod.pod_uuid,
        podVersion: pod.pod_version || 'v3',
        isOnline: false,
        totalRows: 0,
        unsyncedRows: 0,
        syncedRows: 0,
        masterRows: masterRowsForPod,
        masterHistoricalTotal: masterRowsForPod,
        oldestUnsynced: null,
        newestUnsynced: null,
        error: null
      };

      try {
        const isTcpOpen = await checkTcpConnection(pod.host, POD_DB_PORT, 1200);
        if (!isTcpOpen) {
          podAudit.error = 'Port 5432 tidak dapat dijangkau (TCP timeout)';
          return podAudit;
        }

        const podClient = new Client({
          connectionString: getPodDbUrl(pod.host),
          connectionTimeoutMillis: 4000,
          statement_timeout: 10000
        });

        await podClient.connect();
        try {
          const res = await podClient.query(`
            SELECT 
              COUNT(*) as total_count,
              COUNT(*) FILTER (WHERE is_synced = false OR is_synced IS NULL) as unsynced_count,
              COUNT(*) FILTER (WHERE is_synced = true) as synced_count,
              MIN(created_at) FILTER (WHERE is_synced = false OR is_synced IS NULL) as oldest_unsynced,
              MAX(created_at) FILTER (WHERE is_synced = false OR is_synced IS NULL) as newest_unsynced
            FROM public.pod_logs;
          `);

          if (res.rows.length > 0) {
            const row = res.rows[0];
            podAudit.isOnline = true;
            podAudit.totalRows = parseInt(row.total_count, 10) || 0;
            const localFlagUnsynced = parseInt(row.unsynced_count, 10) || 0;

            // Fetch actual row IDs from POD to test physical presence in Master RDS
            let verifiedInMaster = 0;
            let actualMissingFromMaster = 0;

            try {
              const idRes = await podClient.query(
                'SELECT id FROM public.pod_logs ORDER BY created_at DESC LIMIT 15000;'
              );
              const podSampleIds = idRes.rows.map(r => r.id);

              if (podSampleIds.length > 0 && masterClient) {
                const checkRes = await masterClient.query(
                  'SELECT COUNT(*) as found FROM public.pod_logs WHERE id = ANY($1::uuid[]);',
                  [podSampleIds]
                );
                verifiedInMaster = parseInt(checkRes.rows[0].found, 10) || 0;
                actualMissingFromMaster = Math.max(0, podSampleIds.length - verifiedInMaster);
              }
            } catch (idErr) {
              console.warn(`ID verification check error for ${pod.name}:`, idErr.message);
            }

            // The true unsynced count combines both missing IDs and local false flags!
            podAudit.unsyncedRows = Math.max(localFlagUnsynced, actualMissingFromMaster);
            podAudit.syncedRows = verifiedInMaster;
            podAudit.masterRows = verifiedInMaster; // Number of POD's current rows verified in Master
            podAudit.masterHistoricalTotal = masterRowsForPod; // Total rows in Master with this pod_uuid
            podAudit.oldestUnsynced = row.oldest_unsynced;
            podAudit.newestUnsynced = row.newest_unsynced;
          }
        } finally {
          await podClient.end().catch(() => {});
        }
      } catch (podErr) {
        // Fallback: try SSH count if direct PG failed
        try {
          const sshCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT COUNT(*), COUNT(*) FILTER (WHERE is_synced = false OR is_synced IS NULL) FROM public.pod_logs;" 2>/dev/null`;
          const sshOut = await executeSshCommand(pod, sshCmd, { timeoutMs: 7000 });
          const parts = sshOut.trim().split('|');
          if (parts.length >= 2) {
            podAudit.isOnline = true;
            podAudit.totalRows = parseInt(parts[0], 10) || 0;
            const localFlagUnsynced = parseInt(parts[1], 10) || 0;
            const idDiffMissing = Math.max(0, podAudit.totalRows - masterRowsForPod);
            podAudit.unsyncedRows = Math.max(localFlagUnsynced, idDiffMissing);
            podAudit.syncedRows = Math.min(podAudit.totalRows, masterRowsForPod);
            podAudit.masterRows = Math.min(podAudit.totalRows, masterRowsForPod);
          } else {
            podAudit.error = podErr.message;
          }
        } catch (_) {
          podAudit.error = podErr.message;
        }
      }

      return podAudit;
    });

    const podResults = await Promise.all(podAuditPromises);

    const totalUnsyncedAcrossAllPods = podResults.reduce((acc, p) => acc + (p.unsyncedRows || 0), 0);
    const totalRowsAcrossAllPods = podResults.reduce((acc, p) => acc + (p.totalRows || 0), 0);

    return {
      master: {
        id: master.id,
        name: master.name,
        host: master.host,
        database: master.db_name,
        totalRows: masterTotalRows,
        latestCreated: masterLatestCreated
      },
      summary: {
        totalPods: podServers.length,
        onlinePods: podResults.filter(p => p.isOnline).length,
        totalRowsMaster: masterTotalRows,
        totalRowsPods: totalRowsAcrossAllPods,
        totalUnsyncedAcrossAllPods
      },
      pods: podResults
    };
  } catch (masterErr) {
    console.error('Error querying Master DB pod_logs:', masterErr.message);
    throw new Error(`Gagal menghubungi Master DB: ${masterErr.message}`);
  } finally {
    if (masterClient) {
      await masterClient.end().catch(() => {});
    }
  }
}

/**
 * Pull pod_logs from a single POD V3 to Master DB using chunked Keyset cursor batching
 */
async function pullSinglePodLogs({
  masterClient,
  pod,
  options = {},
  onProgress
}) {
  const batchSize = Math.min(Math.max(parseInt(options.batchSize, 10) || 2000, 200), 10000);
  const mode = options.mode || 'unsynced'; // 'unsynced' | 'date_range' | 'all'
  const dateFrom = options.dateFrom || null;
  const dateTo = options.dateTo || null;
  const markSyncedOnPod = options.markSyncedOnPod !== false; // Default true per user request

  let podClient = null;

  try {
    podClient = new Client({
      connectionString: getPodDbUrl(pod.host),
      connectionTimeoutMillis: 8000,
      statement_timeout: 45000
    });
    await podClient.connect();
  } catch (err) {
    throw new Error(`Gagal membuka koneksi PG ke POD ${pod.name} (${pod.host}): ${err.message}`);
  }

  try {
    // 1. Build Base Filter Condition
    const conditions = [];
    const filterParams = [];

    // If mode === 'unsynced', filter by local flag is_synced = false
    // If mode === 'id_diff', we inspect IDs without limiting by is_synced flag
    if (mode === 'unsynced') {
      conditions.push('(is_synced = false OR is_synced IS NULL)');
    }

    if (dateFrom) {
      filterParams.push(dateFrom);
      conditions.push(`created_at >= $${filterParams.length}`);
    }

    if (dateTo) {
      filterParams.push(dateTo);
      conditions.push(`created_at <= $${filterParams.length}`);
    }

    const baseWhere = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count matching rows on POD
    const countRes = await podClient.query(`SELECT COUNT(*) as total FROM public.pod_logs ${baseWhere};`, filterParams);
    const totalMatchingRows = parseInt(countRes.rows[0].total, 10) || 0;

    if (totalMatchingRows === 0) {
      return {
        podId: pod.id,
        podName: pod.name,
        totalMatchingRows: 0,
        rowsProcessed: 0,
        batchesCompleted: 0,
        message: 'Tidak ada baris data pod_logs yang perlu ditarik.'
      };
    }

    const estimatedBatches = Math.ceil(totalMatchingRows / batchSize);
    let rowsProcessed = 0;
    let batchesCompleted = 0;
    const startTime = Date.now();

    let cursorTime = null;
    let cursorId = null;
    let hasMore = true;

    while (hasMore) {
      batchesCompleted++;
      const batchConditions = [...conditions];
      const batchParams = [...filterParams];

      // Keyset cursor pagination (super fast <5ms index seek)
      if (cursorTime && cursorId) {
        batchParams.push(cursorTime);
        const pTimeIdx = batchParams.length;
        batchParams.push(cursorId);
        const pIdIdx = batchParams.length;
        batchConditions.push(`(created_at > $${pTimeIdx} OR (created_at = $${pTimeIdx} AND id > $${pIdIdx}))`);
      }

      const batchWhere = batchConditions.length > 0 ? `WHERE ${batchConditions.join(' AND ')}` : '';
      const query = `
        SELECT 
          id, pod_id, user_id, code, value, activity_type, data,
          timestamp_start, activity_key, sub_ativity_key, is_synced,
          created_at, updated_at, deleted_at
        FROM public.pod_logs
        ${batchWhere}
        ORDER BY created_at ASC, id ASC
        LIMIT ${batchSize};
      `;

      const chunkRes = await podClient.query(query, batchParams);
      const rows = chunkRes.rows;

      if (!rows || rows.length === 0) {
        hasMore = false;
        break;
      }

      let rowsToInsert = rows;

      // In 'id_diff' mode, check Master DB to find which IDs are missing
      if (mode === 'id_diff') {
        const chunkIds = rows.map(r => r.id);
        const inMasterRes = await masterClient.query(
          'SELECT id FROM public.pod_logs WHERE id = ANY($1::uuid[]);',
          [chunkIds]
        );
        const existingInMaster = new Set(inMasterRes.rows.map(r => r.id));
        rowsToInsert = rows.filter(r => !existingInMaster.has(r.id));
      }

      // Upsert missing/candidate rows to Master DB
      if (rowsToInsert.length > 0) {
        await upsertLogsBatchToMaster(masterClient, rowsToInsert);
      }

      // Mark is_synced = true in POD DB for all verified/inserted rows
      if (markSyncedOnPod) {
        const uuidList = rows.map(r => r.id);
        await podClient.query(
          'UPDATE public.pod_logs SET is_synced = true, updated_at = NOW() WHERE id = ANY($1::uuid[]);',
          [uuidList]
        );
      }

      rowsProcessed += (mode === 'id_diff' ? rowsToInsert.length : rows.length);

      // Update cursor for next chunk
      const lastRow = rows[rows.length - 1];
      cursorTime = lastRow.created_at;
      cursorId = lastRow.id;

      if (rows.length < batchSize) {
        hasMore = false;
      }

      const elapsedSec = Math.max((Date.now() - startTime) / 1000, 0.1);
      const speed = Math.round(rowsProcessed / elapsedSec);
      const percent = Math.min(Math.round((rowsProcessed / totalMatchingRows) * 100), 100);

      onProgress?.({
        podId: pod.id,
        podName: pod.name,
        batchIndex: batchesCompleted,
        estimatedBatches,
        rowsProcessed,
        totalMatchingRows,
        percent,
        speedRowsPerSec: speed
      });
    }

    const totalElapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      podId: pod.id,
      podName: pod.name,
      totalMatchingRows,
      rowsProcessed,
      batchesCompleted,
      durationSec: parseFloat(totalElapsedSec),
      speedRowsPerSec: Math.round(rowsProcessed / Math.max(parseFloat(totalElapsedSec), 0.1))
    };
  } finally {
    if (podClient) {
      await podClient.end().catch(() => {});
    }
  }
}

/**
 * Fast Multi-Row UPSERT into Master DB (ON CONFLICT (id) DO UPDATE)
 */
async function upsertLogsBatchToMaster(masterClient, rows) {
  if (!rows || rows.length === 0) return;

  const colList = [
    'id', 'pod_id', 'user_id', 'code', 'value', 'activity_type', 'data',
    'timestamp_start', 'activity_key', 'sub_ativity_key', 'is_synced',
    'created_at', 'updated_at', 'deleted_at'
  ];

  const params = [];
  const valueTuples = [];

  rows.forEach((row) => {
    const rowPlaceholders = [];
    colList.forEach((col) => {
      let val = row[col];
      // Mark as synced on Master
      if (col === 'is_synced') {
        val = true;
      }
      params.push(val === undefined ? null : val);
      rowPlaceholders.push(`$${params.length}`);
    });
    valueTuples.push(`(${rowPlaceholders.join(', ')})`);
  });

  const updateSet = colList
    .filter(c => c !== 'id')
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  const sql = `
    INSERT INTO public.pod_logs (${colList.map(c => `"${c}"`).join(', ')})
    VALUES ${valueTuples.join(', ')}
    ON CONFLICT ("id") DO UPDATE SET
      ${updateSet};
  `;

  await masterClient.query(sql, params);
}

/**
 * Orchestrator to pull logs across one or multiple POD V3 servers
 */
async function pullPodLogsFleet({
  masterId,
  targetPodIds = [],
  options = {},
  onProgress
}) {
  if (!masterId) {
    throw new Error('masterId wajib disertakan.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) {
    throw new Error('Master DB tidak ditemukan.');
  }

  // Strictly target ONLY POD V3 servers
  let sqlPods = "SELECT id, name, host, port, username, password, private_key, auth_type, code, pod_version FROM servers WHERE LOWER(pod_version) = 'v3'";
  const params = [];
  if (Array.isArray(targetPodIds) && targetPodIds.length > 0) {
    const placeholders = targetPodIds.map(() => '?').join(',');
    sqlPods += ` AND id IN (${placeholders})`;
    params.push(...targetPodIds);
  }
  sqlPods += " ORDER BY name ASC;";

  const pods = await dbAsync.all(sqlPods, params);
  if (pods.length === 0) {
    throw new Error('Tidak ada unit POD V3 yang dipilih atau ditemukan.');
  }

  const masterClient = createMasterClient(master);
  await masterClient.connect();

  const results = [];

  try {
    for (let i = 0; i < pods.length; i++) {
      const pod = pods[i];
      try {
        onProgress?.({
          stage: 'STARTING_POD',
          podIndex: i + 1,
          totalPods: pods.length,
          podId: pod.id,
          podName: pod.name
        });

        const podRes = await pullSinglePodLogs({
          masterClient,
          pod,
          options,
          onProgress: (prog) => {
            onProgress?.({
              stage: 'PROGRESS',
              podIndex: i + 1,
              totalPods: pods.length,
              ...prog
            });
          }
        });

        results.push({ success: true, ...podRes });
      } catch (podErr) {
        console.error(`Error pulling pod_logs from ${pod.name}:`, podErr.message);
        results.push({
          podId: pod.id,
          podName: pod.name,
          success: false,
          error: podErr.message
        });
      }
    }
  } finally {
    await masterClient.end().catch(() => {});
  }

  const totalProcessed = results.reduce((acc, r) => acc + (r.rowsProcessed || 0), 0);

  return {
    masterId,
    masterName: master.name,
    totalPods: pods.length,
    totalProcessed,
    results
  };
}

/**
 * Server-side paginated explorer for pod_logs on Master DB
 */
async function getMasterPodLogsData({
  masterId,
  page = 1,
  limit = 25,
  podId = null,
  activityType = null,
  search = null,
  dateFrom = null,
  dateTo = null
}) {
  if (!masterId) {
    throw new Error('masterId harus disertakan.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) {
    throw new Error('Master DB tidak ditemukan.');
  }

  const pageNum = Math.max(parseInt(page, 10) || 1, 1);
  const pageLimit = Math.min(Math.max(parseInt(limit, 10) || 25, 5), 100);
  const offset = (pageNum - 1) * pageLimit;

  const masterClient = createMasterClient(master);
  await masterClient.connect();

  try {
    const conditions = [];
    const params = [];

    if (podId) {
      params.push(String(podId).trim());
      conditions.push(`pod_id = $${params.length}`);
    }

    if (activityType && activityType !== 'ALL') {
      params.push(String(activityType).trim());
      conditions.push(`activity_type = $${params.length}`);
    }

    if (dateFrom) {
      params.push(dateFrom);
      conditions.push(`created_at >= $${params.length}`);
    }

    if (dateTo) {
      params.push(dateTo);
      conditions.push(`created_at <= $${params.length}`);
    }

    if (search && search.trim()) {
      params.push(`%${search.trim()}%`);
      const pIdx = params.length;
      conditions.push(`(code ILIKE $${pIdx} OR value ILIKE $${pIdx} OR activity_key ILIKE $${pIdx} OR data ILIKE $${pIdx} OR user_id ILIKE $${pIdx})`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    // Count query
    const countRes = await masterClient.query(`SELECT COUNT(*) as total FROM public.pod_logs ${whereSql};`, params);
    const totalRows = parseInt(countRes.rows[0].total, 10) || 0;
    const totalPages = Math.ceil(totalRows / pageLimit);

    // Data query
    params.push(pageLimit);
    const limitIdx = params.length;
    params.push(offset);
    const offsetIdx = params.length;

    const dataSql = `
      SELECT 
        id, pod_id, user_id, code, value, activity_type, data,
        timestamp_start, activity_key, sub_ativity_key, is_synced,
        created_at, updated_at
      FROM public.pod_logs
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx};
    `;

    const dataRes = await masterClient.query(dataSql, params);

    return {
      page: pageNum,
      limit: pageLimit,
      totalRows,
      totalPages,
      rows: dataRes.rows,
      podUuidMap: await getPodUuidMap()
    };
  } finally {
    await masterClient.end().catch(() => {});
  }
}

/**
 * Get distinct activity types from Master DB for filter pills/dropdown
 */
async function getMasterActivityTypes(masterId) {
  if (!masterId) return [];
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) return [];

  const client = createMasterClient(master);
  await client.connect();
  try {
    const res = await client.query('SELECT DISTINCT activity_type FROM public.pod_logs WHERE activity_type IS NOT NULL ORDER BY activity_type ASC;');
    return res.rows.map(r => r.activity_type).filter(Boolean);
  } catch (_) {
    return [];
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Helper to build UUID -> POD info lookup map
 */
async function getPodUuidMap() {
  try {
    const servers = await dbAsync.all(
      "SELECT id, name, host, code, pod_version, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL AND pod_uuid != ''"
    );
    const map = {};
    for (const s of (servers || [])) {
      if (s.pod_uuid) {
        map[s.pod_uuid] = {
          id: s.id,
          name: s.name,
          host: s.host,
          code: s.code,
          pod_version: s.pod_version
        };
      }
    }
    return map;
  } catch (err) {
    console.error('Error getPodUuidMap:', err.message);
    return {};
  }
}

/**
 * Compare pod_logs data between Master DB and a specific POD V3
 */
async function compareSinglePodLogs({ masterId, podId, limit = 50 }) {
  if (!masterId || !podId) {
    throw new Error('masterId dan podId wajib disertakan.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [podId]);
  if (!pod) throw new Error('Server POD tidak ditemukan.');

  const podUuidMap = await getPodUuidMap();
  const podUuid = pod.pod_uuid || null;

  const masterClient = createMasterClient(master);
  await masterClient.connect();

  let podClient = null;
  try {
    podClient = new Client({
      connectionString: getPodDbUrl(pod.host),
      connectionTimeoutMillis: 5000,
      statement_timeout: 15000
    });
    await podClient.connect();

    // 1. Counters
    const podCountRes = await podClient.query(`
      SELECT 
        COUNT(*) as total_in_pod,
        COUNT(*) FILTER (WHERE is_synced = false OR is_synced IS NULL) as unsynced_in_pod,
        COUNT(*) FILTER (WHERE is_synced = true) as synced_in_pod
      FROM public.pod_logs;
    `);
    const totalInPod = parseInt(podCountRes.rows[0].total_in_pod, 10) || 0;
    const unsyncedInPod = parseInt(podCountRes.rows[0].unsynced_in_pod, 10) || 0;
    const syncedInPod = parseInt(podCountRes.rows[0].synced_in_pod, 10) || 0;

    // Master counts for this POD
    let totalInMasterForPod = 0;
    if (podUuid) {
      const masterCountRes = await masterClient.query(
        'SELECT COUNT(*) as total_in_master FROM public.pod_logs WHERE pod_id = $1;',
        [podUuid]
      );
      totalInMasterForPod = parseInt(masterCountRes.rows[0].total_in_master, 10) || 0;
    }

    // 2. Query ALL row IDs from POD (up to 50,000) to find the EXACT missing rows
    const idRes = await podClient.query(
      'SELECT id, created_at, is_synced FROM public.pod_logs ORDER BY created_at DESC LIMIT 50000;'
    );
    const allPodRows = idRes.rows;
    const allPodIds = allPodRows.map(r => r.id);

    // Verify all IDs in batches against Master DB
    const masterFoundSet = new Set();
    const batchSizeCheck = 5000;
    for (let i = 0; i < allPodIds.length; i += batchSizeCheck) {
      const chunk = allPodIds.slice(i, i + batchSizeCheck);
      const checkRes = await masterClient.query(
        'SELECT id FROM public.pod_logs WHERE id = ANY($1::uuid[]);',
        [chunk]
      );
      for (const r of checkRes.rows) {
        masterFoundSet.add(r.id);
      }
    }

    // Find ALL rows that exist in POD but NOT in Master RDS!
    const missingPodRows = allPodRows.filter(r => !masterFoundSet.has(r.id));
    const missingIds = missingPodRows.map(r => r.id);
    const actualMissingCount = missingIds.length;

    // Fetch full details of the missing rows from POD (up to 200 rows for display)
    let missingInMasterRows = [];
    let falseSyncedCount = 0;

    if (missingIds.length > 0) {
      const targetMissingIds = missingIds.slice(0, 200);
      const missingDetailsRes = await podClient.query(`
        SELECT id, pod_id, user_id, code, value, activity_type, data, timestamp_start, is_synced, created_at, updated_at
        FROM public.pod_logs
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at DESC;
      `, [targetMissingIds]);

      missingInMasterRows = missingDetailsRes.rows.map(row => {
        const isFalseSynced = !!row.is_synced;
        return {
          ...row,
          __status: 'MISSING_IN_MASTER',
          isFalseSynced
        };
      });

      // Total missing rows that have is_synced = true (false flag anomaly)
      falseSyncedCount = missingPodRows.filter(r => r.is_synced).length;
    }

    // 3. For presentInMasterRows, get a sample of rows that are present in Master
    const presentPodRows = allPodRows.filter(r => masterFoundSet.has(r.id)).slice(0, 60);
    let presentInMasterRows = [];
    if (presentPodRows.length > 0) {
      const presentIds = presentPodRows.map(r => r.id);
      const presentDetailsRes = await podClient.query(`
        SELECT id, pod_id, user_id, code, value, activity_type, data, timestamp_start, is_synced, created_at
        FROM public.pod_logs
        WHERE id = ANY($1::uuid[])
        ORDER BY created_at DESC;
      `, [presentIds]);
      presentInMasterRows = presentDetailsRes.rows.map(r => ({
        ...r,
        __status: 'IN_MASTER'
      }));
    }

    // 4. Fetch sample synced rows from Master for this POD
    let masterRows = [];
    if (podUuid) {
      const masterRowsRes = await masterClient.query(`
        SELECT id, pod_id, user_id, code, value, activity_type, data, timestamp_start, is_synced, created_at
        FROM public.pod_logs
        WHERE pod_id = $1
        ORDER BY created_at DESC
        LIMIT 60;
      `, [podUuid]);
      masterRows = masterRowsRes.rows;
    }

    return {
      pod: {
        id: pod.id,
        name: pod.name,
        code: pod.code,
        host: pod.host,
        pod_uuid: podUuid,
        pod_version: pod.pod_version
      },
      master: {
        id: master.id,
        name: master.name,
        host: master.host
      },
      counts: {
        totalInPod,
        unsyncedInPod,
        syncedInPod,
        totalInMasterForPod,
        actualMissingCount,
        missingSampleCount: missingInMasterRows.length,
        falseSyncedCount
      },
      missingInMasterRows,
      presentInMasterRows,
      masterRows,
      podUuidMap
    };
  } finally {
    if (podClient) await podClient.end().catch(() => {});
    if (masterClient) await masterClient.end().catch(() => {});
  }
}

/**
 * Sync a single specific row from POD to Master DB by logId
 */
async function syncSinglePodLogRow({ masterId, podId, logId }) {
  if (!masterId || !podId || !logId) {
    throw new Error('masterId, podId, dan logId wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [podId]);
  if (!pod) throw new Error('Server POD tidak ditemukan.');

  const podClient = new Client({
    connectionString: getPodDbUrl(pod.host),
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000
  });
  await podClient.connect();

  const masterClient = createMasterClient(master);
  await masterClient.connect();

  try {
    const rowRes = await podClient.query(
      'SELECT * FROM public.pod_logs WHERE id = $1::uuid LIMIT 1;',
      [logId]
    );

    if (rowRes.rows.length === 0) {
      throw new Error(`Baris log dengan ID ${logId} tidak ditemukan di POD ${pod.name}.`);
    }

    const row = rowRes.rows[0];

    // Upsert to Master DB
    await upsertLogsBatchToMaster(masterClient, [row]);

    // Mark is_synced = true in POD
    await podClient.query(
      'UPDATE public.pod_logs SET is_synced = true, updated_at = NOW() WHERE id = $1::uuid;',
      [logId]
    );

    return {
      success: true,
      logId,
      podId: pod.id,
      podName: pod.name,
      message: `Baris log ${logId} berhasil disinkronkan ke Master DB.`
    };
  } finally {
    await podClient.end().catch(() => {});
    await masterClient.end().catch(() => {});
  }
}

module.exports = {
  getPodLogsAudit,
  pullPodLogsFleet,
  getMasterPodLogsData,
  getMasterActivityTypes,
  getPodUuidMap,
  compareSinglePodLogs,
  syncSinglePodLogRow
};

