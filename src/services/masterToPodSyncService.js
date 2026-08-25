const { Client } = require('pg');
const dbAsync = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');
const { decrypt } = require('../utils/crypto');

const POD_DB_USER = process.env.POD_DB_USER || 'development';
const POD_DB_PASS = process.env.POD_DB_PASS || 'development';
const POD_DB_NAME = process.env.POD_DB_NAME || 'regenesis';
const POD_DB_PORT = parseInt(process.env.POD_DB_PORT || '5432', 10);

/**
 * Helper to build PG connection string for a POD host
 */
function getPodDbUrl(host) {
  const encUser = encodeURIComponent(POD_DB_USER);
  const encPass = encodeURIComponent(POD_DB_PASS);
  return `postgresql://${encUser}:${encPass}@${host}:${POD_DB_PORT}/${POD_DB_NAME}?schema=public`;
}

/**
 * Helper to build Client for Master DB with SSL support
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
  });
}

/**
 * Helper to filter rows for partitioned tables like 'pod'
 */
function filterRowsForPod(tableName, rows, podServer) {
  if (!rows || rows.length === 0) return [];
  if (tableName === 'pod') {
    const podName = (podServer.name || '').toLowerCase();
    const digits = (podName.match(/\d+/) || [])[0];

    const matched = rows.filter(r => {
      // 1. Match IP address
      if (r.ip_address && podServer.host && r.ip_address.trim() === podServer.host.trim()) return true;
      // 2. Match code (e.g. '31', '36', '41')
      if (digits && r.code && String(r.code).trim() === digits) return true;
      // 3. Match name (e.g. 'F3-1' vs 'POD 31' -> '31' in name)
      if (digits && r.name && r.name.replace(/[^0-9]/g, '') === digits) return true;
      return false;
    });

    if (matched.length > 0) return matched;
  }
  return rows;
}

// In-Memory Schema & Catalog Cache with TTL (Reduces redundant queries on tab switches)
const schemaCache = new Map();
const CACHE_TTL_MS = 60 * 1000; // 60 seconds

function getCached(key) {
  const item = schemaCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    schemaCache.delete(key);
    return null;
  }
  return item.data;
}

function setCached(key, data, ttlMs = CACHE_TTL_MS) {
  schemaCache.set(key, {
    data,
    expiresAt: Date.now() + ttlMs
  });
}

function clearSchemaCache(pattern = '') {
  if (!pattern) {
    schemaCache.clear();
    return;
  }
  for (const key of schemaCache.keys()) {
    if (key.includes(pattern)) {
      schemaCache.delete(key);
    }
  }
}

/**
 * Concurrency Limiter: Run array of async tasks with controlled parallelism
 * Mencegah lonjakan beban socket descriptor, CPU, dan SSH serentak
 * @param {Array<() => Promise<any>>} taskFns 
 * @param {number} limit 
 */
async function runWithConcurrencyLimit(taskFns, limit = 8) {
  if (!Array.isArray(taskFns) || taskFns.length === 0) return [];
  const results = new Array(taskFns.length);
  let currentIndex = 0;

  async function worker() {
    while (currentIndex < taskFns.length) {
      const idx = currentIndex++;
      try {
        results[idx] = await taskFns[idx]();
      } catch (err) {
        results[idx] = { error: err.message || 'Worker Error' };
      }
    }
  }

  const workerCount = Math.min(limit, taskFns.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * 1. Fetch registered Master Databases
 */
async function getMasterDatabases() {
  const masters = await dbAsync.all(
    'SELECT id, name, host, port, db_name, db_user FROM databases_postgres ORDER BY id ASC'
  );
  return masters;
}

/**
 * 2. Fetch public tables and their row counts + FK relations from selected Master Database
 * Ultra-Fast Single Aggregated Query (Eliminates N+1 query loops)
 */
async function getMasterTables(masterId, bypassCache = false) {
  const cacheKey = `master_tables_${masterId}`;
  if (!bypassCache) {
    const cached = getCached(cacheKey);
    if (cached) return cached;
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error(`Database Master dengan ID ${masterId} tidak ditemukan.`);

  const client = createMasterClient(master);
  await client.connect();
  try {
    // 1. Single Ultra-Fast Query: Fetches all tables, column counts, and live row counts in < 20ms
    const singleQuery = `
      SELECT 
        t.table_name,
        COALESCE(col_counts.cnt, 0) AS column_count,
        COALESCE(s.n_live_tup, c.reltuples::bigint, 0) AS row_count
      FROM information_schema.tables t
      LEFT JOIN (
        SELECT table_name, COUNT(*) AS cnt
        FROM information_schema.columns
        WHERE table_schema = 'public'
        GROUP BY table_name
      ) col_counts ON col_counts.table_name = t.table_name
      LEFT JOIN pg_stat_user_tables s ON s.relname = t.table_name AND s.schemaname = 'public'
      LEFT JOIN pg_class c ON c.relname = t.table_name AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
      WHERE t.table_schema = 'public' 
        AND t.table_type = 'BASE TABLE'
        AND t.table_name NOT LIKE '_prisma%'
        AND t.table_name NOT LIKE 'spatial_ref_sys'
      ORDER BY t.table_name ASC;
    `;
    const res = await client.query(singleQuery);

    // 2. Fetch all foreign key constraints in public schema in one query
    const fkQuery = `
      SELECT
        tc.table_name, 
        kcu.column_name, 
        ccu.table_name AS foreign_table_name,
        ccu.column_name AS foreign_column_name 
      FROM information_schema.table_constraints AS tc 
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage AS ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' 
        AND tc.table_schema = 'public';
    `;
    let allForeignKeys = [];
    try {
      const fkRes = await client.query(fkQuery);
      allForeignKeys = fkRes.rows || [];
    } catch (e) {
      allForeignKeys = [];
    }

    const tablesWithRows = res.rows.map(row => {
      const tName = row.table_name;
      const parents = allForeignKeys
        .filter(fk => fk.table_name === tName)
        .map(fk => ({
          columnName: fk.column_name,
          foreignTableName: fk.foreign_table_name,
          foreignColumnName: fk.foreign_column_name
        }));
      const children = allForeignKeys
        .filter(fk => fk.foreign_table_name === tName)
        .map(fk => ({
          tableName: fk.table_name,
          columnName: fk.column_name,
          foreignColumnName: fk.foreign_column_name
        }));

      let relationType = 'standalone';
      if (parents.length > 0 && children.length > 0) relationType = 'complex';
      else if (parents.length > 0) relationType = 'child';
      else if (children.length > 0) relationType = 'parent';

      return {
        tableName: tName,
        columnCount: parseInt(row.column_count, 10) || 0,
        rowCount: Math.max(0, parseInt(row.row_count, 10) || 0),
        parents,
        children,
        relationType
      };
    });

    const result = {
      master: { id: master.id, name: master.name, host: master.host, dbName: master.db_name },
      tables: tablesWithRows
    };

    setCached(cacheKey, result, 60 * 1000);
    return result;
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Fetch table columns info from a PG connection (including FK relations)
 * Deduplicates multiple constraint joins so each column is unique.
 */
async function getTableColumnsFromClient(client, tableName) {
  const query = `
    SELECT 
      c.column_name,
      c.data_type,
      c.is_nullable,
      c.column_default,
      c.character_maximum_length,
      c.ordinal_position,
      ccu.table_name AS foreign_table_name,
      ccu.column_name AS foreign_column_name
    FROM information_schema.columns c
    LEFT JOIN information_schema.key_column_usage kcu
      ON c.table_schema = kcu.table_schema
      AND c.table_name = kcu.table_name
      AND c.column_name = kcu.column_name
    LEFT JOIN information_schema.table_constraints tc
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.constraint_type = 'FOREIGN KEY'
    LEFT JOIN information_schema.constraint_column_usage ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE c.table_schema = 'public' AND c.table_name = $1
    ORDER BY c.ordinal_position ASC;
  `;
  const res = await client.query(query, [tableName]);
  const colMap = new Map();

  for (const r of res.rows) {
    if (!colMap.has(r.column_name)) {
      colMap.set(r.column_name, {
        column_name: r.column_name,
        data_type: r.data_type,
        is_nullable: r.is_nullable,
        column_default: r.column_default,
        character_maximum_length: r.character_maximum_length,
        foreignTable: r.foreign_table_name || null,
        foreignColumn: r.foreign_column_name || null
      });
    } else {
      // If column already seen, enrich with foreign table info if not set yet
      const existing = colMap.get(r.column_name);
      if (!existing.foreignTable && r.foreign_table_name) {
        existing.foreignTable = r.foreign_table_name;
        existing.foreignColumn = r.foreign_column_name;
      }
    }
  }

  return Array.from(colMap.values());
}

/**
 * Helper to execute high-performance multi-row batch upserts into PostgreSQL.
 * Chunks rows into batches (e.g. 150 rows per batch query) to prevent connection timeouts and scale to thousands of rows.
 */
async function executeBatchUpsert({
  client,
  tableName,
  colNames,
  rows,
  conflictCol,
  updateSet,
  batchSize = 150
}) {
  if (!rows || rows.length === 0) return 0;

  // Ensure unique column names
  const uniqueCols = Array.from(new Set(colNames));
  const colListStr = uniqueCols.map(c => `"${c}"`).join(', ');

  let processedCount = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const chunk = rows.slice(i, i + batchSize);
    const valuePlaceholders = [];
    const values = [];

    chunk.forEach(row => {
      const rowPlaceholders = [];
      uniqueCols.forEach(col => {
        values.push(row[col] !== undefined ? row[col] : null);
        rowPlaceholders.push(`$${values.length}`);
      });
      valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
    });

    let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES ${valuePlaceholders.join(', ')}`;
    if (updateSet) {
      upsertSql += ` ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet}`;
    } else {
      upsertSql += ` ON CONFLICT ("${conflictCol}") DO NOTHING`;
    }

    await client.query(upsertSql, values);
    processedCount += chunk.length;
  }

  return processedCount;
}

/**
 * Helper to fetch table data & columns from a POD (Direct PG with SSH Fallback)
 */
async function fetchPodTableInfo(podServer, tableName) {
  const host = podServer.host;

  // 1. Direct PG
  try {
    const client = new Client({
      connectionString: getPodDbUrl(host),
      connectionTimeoutMillis: 2500,
      statement_timeout: 5000
    });

    await client.connect();
    try {
      const columns = await getTableColumnsFromClient(client, tableName);
      if (columns.length === 0) {
        return {
          serverId: podServer.id,
          serverName: podServer.name,
          isOnline: true,
          tableExists: false,
          columns: [],
          rowCount: 0,
          rows: []
        };
      }

      // Fetch primary key or first column for order
      const pkQuery = `
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.constraint_type = 'PRIMARY KEY'
          AND tc.table_schema = 'public'
          AND tc.table_name = $1;
      `;
      const pkRes = await client.query(pkQuery, [tableName]);
      const pkCol = pkRes.rows.length > 0 ? pkRes.rows[0].column_name : columns[0]?.column_name || 'id';

      const dataRes = await client.query(`SELECT * FROM public."${tableName}" ORDER BY "${pkCol}" ASC LIMIT 500`);
      const countRes = await client.query(`SELECT COUNT(*) as cnt FROM public."${tableName}"`);

      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: true,
        tableExists: true,
        columns,
        rowCount: parseInt(countRes.rows[0].cnt, 10),
        rows: dataRes.rows,
        pkColumn: pkCol
      };
    } finally {
      await client.end().catch(() => { });
    }
  } catch (directErr) {
    // 2. SSH Fallback
    try {
      const checkTableCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='${tableName}';"`;
      const checkRes = await executeSshCommand(podServer, checkTableCmd);
      const exists = parseInt((checkRes || '').trim(), 10) > 0;

      if (!exists) {
        return {
          serverId: podServer.id,
          serverName: podServer.name,
          isOnline: true,
          tableExists: false,
          columns: [],
          rowCount: 0,
          rows: []
        };
      }

      const colsCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT json_agg(t) FROM (SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='${tableName}' ORDER BY ordinal_position) t;"`;
      const colsRaw = await executeSshCommand(podServer, colsCmd);
      let columns = [];
      try { columns = JSON.parse(colsRaw || '[]'); } catch (e) { columns = []; }

      const countCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT COUNT(*) FROM public.\\"${tableName}\\";"`;
      const countRaw = await executeSshCommand(podServer, countCmd);
      const rowCount = parseInt((countRaw || '').trim(), 10) || 0;

      const dataCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT json_agg(t) FROM (SELECT * FROM public.\\"${tableName}\\" LIMIT 500) t;"`;
      const dataRaw = await executeSshCommand(podServer, dataCmd);
      let rows = [];
      try { rows = JSON.parse(dataRaw || '[]'); } catch (e) { rows = []; }

      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: true,
        tableExists: true,
        columns,
        rowCount,
        rows: Array.isArray(rows) ? rows : []
      };
    } catch (sshErr) {
      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: false,
        tableExists: false,
        error: 'Offline / DB Unreachable',
        columns: [],
        rowCount: 0,
        rows: []
      };
    }
  }
}

/**
 * 3. Compare Master Table against All POD V3 Servers (Schema + Data Matrix)
 */
async function compareMasterTableAcrossPods(masterId, tableName) {
  if (!masterId || !tableName) throw new Error('Master Database ID dan Nama Tabel wajib diisi.');

  // 1. Fetch Master DB info and data
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const masterClient = createMasterClient(master);

  let masterColumns = [];
  let masterRows = [];
  let masterRowCount = 0;
  let masterPkColumn = 'id';

  await masterClient.connect();
  try {
    masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    if (masterColumns.length === 0) {
      throw new Error(`Tabel '${tableName}' tidak ditemukan pada Master Database '${master.name}'.`);
    }

    // Determine PK
    const pkQuery = `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1;
    `;
    const pkRes = await masterClient.query(pkQuery, [tableName]);
    if (pkRes.rows.length > 0) {
      masterPkColumn = pkRes.rows[0].column_name;
    } else {
      masterPkColumn = masterColumns[0].column_name;
    }

    const countRes = await masterClient.query(`SELECT COUNT(*) as cnt FROM public."${tableName}"`);
    masterRowCount = parseInt(countRes.rows[0].cnt, 10);

    const rowsRes = await masterClient.query(`SELECT * FROM public."${tableName}" ORDER BY "${masterPkColumn}" ASC LIMIT 500`);
    masterRows = rowsRes.rows;
  } finally {
    await masterClient.end().catch(() => { });
  }

  // 2. Fetch all POD V3 servers
  const podV3List = await dbAsync.all(
    "SELECT id, name, host, port, username, password, private_key FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
  );

  // 3. Query all PODs with Controlled Concurrency Pool (Prevents socket exhaustion & CPU load spikes)
  const taskFns = podV3List.map(pod => () => fetchPodTableInfo(pod, tableName));
  const podResults = await runWithConcurrencyLimit(taskFns, 8);

  // 4. Build Column Schema Matrix
  const columnMatrix = masterColumns.map(col => {
    const presenceByPod = {};
    let presentCount = 0;

    for (const pod of podV3List) {
      const podRes = podResults.find(r => r.serverId === pod.id);
      if (!podRes || !podRes.isOnline) {
        presenceByPod[pod.id] = { isOnline: false, exists: false, typeMatch: false };
      } else if (!podRes.tableExists) {
        presenceByPod[pod.id] = { isOnline: true, exists: false, typeMatch: false };
      } else {
        const podCol = podRes.columns.find(c => c.column_name === col.column_name);
        if (podCol) {
          const typeMatch = podCol.data_type === col.data_type;
          presenceByPod[pod.id] = {
            isOnline: true,
            exists: true,
            typeMatch,
            podType: podCol.data_type
          };
          presentCount++;
        } else {
          presenceByPod[pod.id] = { isOnline: true, exists: false, typeMatch: false };
        }
      }
    }

    return {
      columnName: col.column_name,
      dataType: col.data_type,
      isNullable: col.is_nullable,
      isPk: col.column_name === masterPkColumn,
      presence: presenceByPod,
      presentCount,
      totalPods: podV3List.length
    };
  });

  // 5. Build True Bidirectional Data Row Matrix (Master Rows + POD-exclusive Rows)
  const getRowKey = (row) => {
    if (!row) return '';
    if (row.key) return String(row.key);
    if (row.topic) return String(row.topic);
    if (row.code) return String(row.code);
    if (row[masterPkColumn] !== undefined) return String(row[masterPkColumn]);
    return JSON.stringify(row);
  };

  const allRowsMap = new Map();

  // A. Add Master rows
  masterRows.forEach(mr => {
    const key = getRowKey(mr);
    allRowsMap.set(key, {
      rowKey: key,
      sampleData: mr,
      inMaster: true,
      originPodId: null,
      originPodName: null,
      podSources: [],
      podIds: [],
      podSourcesDetail: []
    });
  });

  // B. Add rows found exclusively in PODs (born in POD, not yet in Master)
  for (const pod of podV3List) {
    const podRes = podResults.find(r => r.serverId === pod.id);
    if (podRes && podRes.isOnline && podRes.tableExists && Array.isArray(podRes.rows)) {
      for (const pr of podRes.rows) {
        const key = getRowKey(pr);
        const podLabel = `${pod.name}${pod.host ? ` (${pod.host})` : ''}`;
        if (allRowsMap.has(key)) {
          const item = allRowsMap.get(key);
          if (!item.podSources.includes(pod.name)) {
            item.podSources.push(pod.name);
          }
          if (!item.podIds) item.podIds = [];
          if (!item.podIds.includes(pod.id)) {
            item.podIds.push(pod.id);
          }
          if (!item.podSourcesDetail) item.podSourcesDetail = [];
          if (!item.podSourcesDetail.includes(podLabel)) {
            item.podSourcesDetail.push(podLabel);
          }
        } else {
          allRowsMap.set(key, {
            rowKey: key,
            sampleData: pr,
            inMaster: false,
            originPodId: pod.id,
            originPodName: pod.name,
            originPodHost: pod.host,
            podSources: [pod.name],
            podIds: [pod.id],
            podSourcesDetail: [podLabel]
          });
        }
      }
    }
  }

  // C. Map presence across all PODs for every row in both Master & PODs
  const dataMatrix = Array.from(allRowsMap.values()).map(item => {
    const presenceByPod = {};
    let presentCount = 0;

    for (const pod of podV3List) {
      const podRes = podResults.find(r => r.serverId === pod.id);
      if (!podRes || !podRes.isOnline) {
        presenceByPod[pod.id] = { isOnline: false, present: false };
      } else if (!podRes.tableExists) {
        presenceByPod[pod.id] = { isOnline: true, present: false };
      } else {
        const found = podRes.rows.some(pr => getRowKey(pr) === item.rowKey);
        if (found) {
          presenceByPod[pod.id] = { isOnline: true, present: true };
          presentCount++;
        } else {
          presenceByPod[pod.id] = { isOnline: true, present: false };
        }
      }
    }

    return {
      rowKey: item.rowKey,
      sampleData: item.sampleData,
      inMaster: item.inMaster,
      isPodOnly: !item.inMaster,
      originPodId: item.originPodId,
      originPodName: item.originPodName,
      originPodHost: item.originPodHost,
      podSources: item.podSources || [],
      podIds: item.podIds || (item.originPodId ? [item.originPodId] : []),
      podSourcesDetail: item.podSourcesDetail || item.podSources || [],
      presence: presenceByPod,
      presentCount,
      totalPods: podV3List.length
    };
  });

  // 6. Build High-Level POD Summary Matrix
  const podSummaries = podV3List.map(pod => {
    const podRes = podResults.find(r => r.serverId === pod.id);
    if (!podRes || !podRes.isOnline) {
      return {
        id: pod.id,
        name: pod.name,
        isOnline: false,
        tableExists: false,
        rowCount: 0,
        status: 'OFFLINE',
        missingColumnsCount: masterColumns.length,
        missingRowsCount: masterRowCount
      };
    }

    if (!podRes.tableExists) {
      return {
        id: pod.id,
        name: pod.name,
        isOnline: true,
        tableExists: false,
        rowCount: 0,
        status: 'TABLE_MISSING',
        missingColumnsCount: masterColumns.length,
        missingRowsCount: masterRowCount
      };
    }

    // Check missing columns
    const missingCols = masterColumns.filter(
      mc => !podRes.columns.some(pc => pc.column_name === mc.column_name)
    );

    // Check missing rows
    const missingRows = masterRows.filter(
      mr => !podRes.rows.some(pr => getRowKey(pr) === getRowKey(mr))
    );

    let status = 'SYNCED';
    if (missingCols.length > 0) status = 'COLUMN_MISMATCH';
    else if (missingRows.length > 0 || podRes.rowCount !== masterRowCount) status = 'ROW_MISMATCH';

    return {
      id: pod.id,
      name: pod.name,
      isOnline: true,
      tableExists: true,
      rowCount: podRes.rowCount,
      status,
      missingColumnsCount: missingCols.length,
      missingRowsCount: missingRows.length,
      missingColumns: missingCols.map(c => c.column_name),
      missingRowsSample: missingRows.slice(0, 10).map(r => getRowKey(r))
    };
  });

  // Overall statistics
  const onlinePodsCount = podSummaries.filter(p => p.isOnline).length;
  const syncedPodsCount = podSummaries.filter(p => p.status === 'SYNCED').length;
  const mismatchPodsCount = podSummaries.filter(p => p.isOnline && p.status !== 'SYNCED').length;
  const podOnlyRowsCount = dataMatrix.filter(d => !d.inMaster).length;

  return {
    master: {
      id: master.id,
      name: master.name,
      host: master.host,
      tableName,
      pkColumn: masterPkColumn,
      columnCount: masterColumns.length,
      rowCount: masterRowCount
    },
    pods: podSummaries,
    columnsMatrix: columnMatrix,
    dataMatrix,
    summary: {
      totalPods: podV3List.length,
      onlinePods: onlinePodsCount,
      offlinePods: podV3List.length - onlinePodsCount,
      syncedPods: syncedPodsCount,
      mismatchPods: mismatchPodsCount,
      podOnlyRowsCount,
      isAllSynced: onlinePodsCount > 0 && syncedPodsCount === onlinePodsCount && podOnlyRowsCount === 0
    }
  };
}

/**
 * 4. Broadcast Sync Master Table to Selected PODs
 */
async function syncMasterTableToPods({ masterId, tableName, targetPodIds = [], dryRun = false, syncColumns = true, syncData = true }) {
  if (!masterId || !tableName || targetPodIds.length === 0) {
    throw new Error('Master DB, Nama Tabel, dan Target POD wajib ditentukan.');
  }

  // 1. Fetch Master Data and Columns
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const masterClient = createMasterClient(master);

  let masterColumns = [];
  let masterRows = [];
  let pkColumn = 'id';

  await masterClient.connect();
  try {
    masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    if (masterColumns.length === 0) throw new Error(`Tabel ${tableName} tidak ada di Master DB.`);

    const pkQuery = `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1;
    `;
    const pkRes = await masterClient.query(pkQuery, [tableName]);
    if (pkRes.rows.length > 0) pkColumn = pkRes.rows[0].column_name;

    const dataRes = await masterClient.query(`SELECT * FROM public."${tableName}" ORDER BY "${pkColumn}" ASC`);
    masterRows = dataRes.rows;
  } finally {
    await masterClient.end().catch(() => { });
  }

  // 2. Fetch target POD servers
  const targetPods = await dbAsync.all(
    `SELECT id, name, host, port, username, password, private_key FROM servers WHERE id IN (${targetPodIds.map(() => '?').join(',')})`,
    targetPodIds
  );

  const results = [];

  for (const pod of targetPods) {
    const podResult = {
      serverId: pod.id,
      serverName: pod.name,
      success: false,
      columnsAdded: [],
      rowsSynced: 0,
      logs: [],
      error: null
    };

    try {
      const client = new Client({
        connectionString: getPodDbUrl(pod.host),
        connectionTimeoutMillis: 4000,
        statement_timeout: 20000
      });

      await client.connect();

      try {
        if (!dryRun) {
          await client.query('BEGIN');
          await client.query("SET LOCAL session_replication_role = 'replica';").catch(() => { });
        }

        // A. Ensure Table and Missing Columns Exist
        const podColumns = await getTableColumnsFromClient(client, tableName);

        if (podColumns.length === 0) {
          // Table doesn't exist: Create table based on Master Columns
          const colDefs = masterColumns.map(c => {
            let def = `"${c.column_name}" ${c.data_type}`;
            if (c.column_name === pkColumn) def += ' PRIMARY KEY';
            return def;
          }).join(', ');

          const createSql = `CREATE TABLE IF NOT EXISTS public."${tableName}" (${colDefs});`;
          podResult.logs.push(`[Table Create] ${createSql}`);

          if (!dryRun) {
            await client.query(createSql);
          }
        } else if (syncColumns) {
          // Table exists: Add missing columns
          for (const mc of masterColumns) {
            const exists = podColumns.some(pc => pc.column_name === mc.column_name);
            if (!exists) {
              const addColSql = `ALTER TABLE public."${tableName}" ADD COLUMN "${mc.column_name}" ${mc.data_type};`;
              podResult.logs.push(`[Column Add] ${addColSql}`);
              podResult.columnsAdded.push(mc.column_name);

              if (!dryRun) {
                await client.query(addColSql);
              }
            }
          }
        }

        // B. Upsert Master Rows (with Partition Scope awareness for table 'pod')
        const rowsToSync = filterRowsForPod(tableName, masterRows, pod);
        if (tableName === 'pod' && rowsToSync.length < masterRows.length) {
          podResult.logs.push(`[Partisi] Menggunakan filter partisi khusus POD: ${rowsToSync.length} dari total ${masterRows.length} baris Master.`);
        }

        if (syncData && rowsToSync.length > 0) {
          const colNames = Array.from(new Set(masterColumns.map(c => c.column_name)));
          const conflictCol = colNames.includes('key') ? 'key' : (colNames.includes('topic') ? 'topic' : pkColumn);
          const updateSet = colNames
            .filter(c => c !== conflictCol && c !== 'id')
            .map(c => `"${c}" = EXCLUDED."${c}"`)
            .join(', ');

          if (!dryRun) {
            const syncedCount = await executeBatchUpsert({
              client,
              tableName,
              colNames,
              rows: rowsToSync,
              conflictCol,
              updateSet,
              batchSize: 150
            });
            podResult.rowsSynced = syncedCount;
          } else {
            podResult.rowsSynced = rowsToSync.length;
          }
        }

        if (!dryRun) {
          await client.query('COMMIT');
        }

        podResult.success = true;
        podResult.logs.push(`[Completed] ${dryRun ? 'Simulasi' : 'Sinkronisasi'} sukses: ${podResult.rowsSynced} baris data diproses.`);
      } catch (execErr) {
        if (!dryRun) {
          await client.query('ROLLBACK').catch(() => { });
        }
        throw execErr;
      } finally {
        await client.end().catch(() => { });
      }
    } catch (podErr) {
      podResult.success = false;
      podResult.error = podErr.message;
      podResult.logs.push(`[Error] Gagal sinkronisasi ke ${pod.name}: ${podErr.message}`);
    }

    results.push(podResult);
  }

  return {
    master: { id: master.id, name: master.name, tableName },
    dryRun,
    totalTargets: targetPods.length,
    successfulTargets: results.filter(r => r.success).length,
    results
  };
}

/**
 * Helper to discover all child tables referencing tableName(pkColumn)
 */
async function findChildRelations(client, tableName) {
  const fkQuery = `
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    WHERE tc.constraint_type = 'FOREIGN KEY'
      AND tc.table_schema = 'public'
      AND ccu.table_name = $1;
  `;
  try {
    const res = await client.query(fkQuery, [tableName]);
    return res.rows || [];
  } catch (e) {
    return [];
  }
}

/**
 * 5. Cascade Hard Delete specific row(s) from Master Database (and propagate to all PODs)
 */
async function deleteMasterTableRow({ masterId, tableName, pkColumn = 'id', pkValue, pkValues, cascade = true, deleteFromPods = true }) {
  const valuesToDelete = Array.isArray(pkValues) && pkValues.length > 0 ? pkValues : (pkValue !== undefined ? [pkValue] : []);
  if (!masterId || !tableName || valuesToDelete.length === 0) {
    throw new Error('masterId, tableName, dan pkValue/pkValues wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();
  let deletedCount = 0;
  let cascadeCount = 0;
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL session_replication_role = 'replica';");

    // 1. If cascade is true, find child tables and delete referencing child rows first
    if (cascade) {
      const childRelations = await findChildRelations(client, tableName);
      for (const rel of childRelations) {
        if (rel.child_table !== tableName) {
          const childDeleteSql = `DELETE FROM public."${rel.child_table}" WHERE "${rel.child_column}"::text = ANY($1::text[])`;
          const childRes = await client.query(childDeleteSql, [valuesToDelete.map(String)]).catch(() => ({ rowCount: 0 }));
          cascadeCount += (childRes.rowCount || 0);
        }
      }
    }

    // 2. Delete parent rows in Master
    const query = `DELETE FROM public."${tableName}" WHERE "${pkColumn}"::text = ANY($1::text[]) RETURNING *;`;
    const res = await client.query(query, [valuesToDelete.map(String)]);
    deletedCount = res.rowCount;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    await client.end().catch(() => { });
  }

  // 3. Propagate delete to ALL POD V3 servers so rows with these IDs are also purged in every POD
  const podDeleteResults = [];
  if (deleteFromPods !== false) {
    const podV3List = await dbAsync.all(
      "SELECT id, name, host, port, username, password, private_key FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
    );

    for (const pod of podV3List) {
      try {
        const podRes = await deletePodTableRow({
          serverId: pod.id,
          tableName,
          pkColumn,
          pkValues: valuesToDelete,
          cascade
        });
        podDeleteResults.push({
          serverId: pod.id,
          serverName: pod.name,
          deletedCount: podRes.deletedCount || 0,
          cascadeCount: podRes.cascadeCount || 0
        });
      } catch (podErr) {
        console.warn(`[DeleteMaster] Gagal propagate delete ke ${pod.name}:`, podErr.message);
        podDeleteResults.push({
          serverId: pod.id,
          serverName: pod.name,
          error: podErr.message
        });
      }
    }
  }

  return {
    success: true,
    masterId,
    tableName,
    pkColumn,
    deletedCount,
    deletedKeys: valuesToDelete,
    cascadeCount,
    podDeleteResults
  };
}

/**
 * 6. Cascade Hard Delete specific row(s) from a target POD Database (or across multiple PODs)
 */
async function deletePodTableRow({ serverId, serverIds, tableName, pkColumn = 'id', pkValue, pkValues, cascade = true }) {
  const valuesToDelete = Array.isArray(pkValues) && pkValues.length > 0 ? pkValues : (pkValue !== undefined ? [pkValue] : []);
  const targetServerIds = Array.isArray(serverIds) && serverIds.length > 0
    ? serverIds.map(Number)
    : (serverId ? [Number(serverId)] : []);

  if (targetServerIds.length === 0 || !tableName || valuesToDelete.length === 0) {
    throw new Error('serverId/serverIds, tableName, dan pkValue/pkValues wajib diisi.');
  }

  let totalDeleted = 0;
  let totalCascade = 0;
  const podResults = [];

  for (const sId of targetServerIds) {
    const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sId]);
    if (!pod) continue;

    let deletedCount = 0;
    let cascadeCount = 0;

    // 1. Direct PG
    try {
      const client = new Client({
        connectionString: getPodDbUrl(pod.host),
        connectionTimeoutMillis: 3000,
        statement_timeout: 6000
      });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query("SET LOCAL session_replication_role = 'replica';");

        if (cascade) {
          const childRelations = await findChildRelations(client, tableName);
          for (const rel of childRelations) {
            if (rel.child_table !== tableName) {
              const childDeleteSql = `DELETE FROM public."${rel.child_table}" WHERE "${rel.child_column}"::text = ANY($1::text[])`;
              const childRes = await client.query(childDeleteSql, [valuesToDelete.map(String)]).catch(() => ({ rowCount: 0 }));
              cascadeCount += (childRes.rowCount || 0);
            }
          }
        }

        const query = `DELETE FROM public."${tableName}" WHERE "${pkColumn}"::text = ANY($1::text[]) RETURNING *;`;
        const res = await client.query(query, [valuesToDelete.map(String)]);
        deletedCount = res.rowCount;
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        throw err;
      } finally {
        await client.end().catch(() => { });
      }
    } catch (err) {
      // 2. SSH Fallback
      try {
        const formattedKeys = valuesToDelete.map(v => `'${String(v).replace(/'/g, "''")}'`).join(',');
        const deleteCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -c "SET session_replication_role = 'replica'; DELETE FROM public.\\"${tableName}\\" WHERE \\"${pkColumn}\\"::text IN (${formattedKeys});"`;
        await executeSshCommand(pod, deleteCmd);
        deletedCount = valuesToDelete.length;
      } catch (sshErr) {
        console.warn(`[DeletePod] Gagal delete di ${pod.name}:`, sshErr.message);
      }
    }

    totalDeleted += deletedCount;
    totalCascade += cascadeCount;
    podResults.push({
      serverId: pod.id,
      serverName: pod.name,
      deletedCount,
      cascadeCount
    });
  }

  const primaryPod = podResults[0] || {};

  return {
    success: true,
    serverId: primaryPod.serverId,
    serverName: primaryPod.serverName,
    tableName,
    pkColumn,
    deletedCount: totalDeleted,
    deletedKeys: valuesToDelete,
    cascadeCount: totalCascade,
    podResults
  };
}

/**
 * 7. Sync a single row from Master Database to Selected PODs
 */
async function syncSingleMasterRowToPods({ masterId, tableName, pkColumn = 'id', pkValue, targetPodIds = [] }) {
  if (!masterId || !tableName || pkValue === undefined || targetPodIds.length === 0) {
    throw new Error('masterId, tableName, pkValue, dan targetPodIds wajib diisi.');
  }

  // 1. Fetch Master Row & Column metadata
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const masterClient = createMasterClient(master);
  let masterColumns = [];
  let singleRow = null;

  await masterClient.connect();
  try {
    masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    if (masterColumns.length === 0) throw new Error(`Tabel ${tableName} tidak ada di Master DB.`);

    const query = `SELECT * FROM public."${tableName}" WHERE "${pkColumn}" = $1 LIMIT 1;`;
    const res = await masterClient.query(query, [pkValue]);
    if (res.rows.length === 0) {
      throw new Error(`Baris dengan ${pkColumn} = '${pkValue}' tidak ditemukan pada Master Database.`);
    }
    singleRow = res.rows[0];
  } finally {
    await masterClient.end().catch(() => { });
  }

  // 2. Fetch target POD servers
  const targetPods = await dbAsync.all(
    `SELECT id, name, host, port, username, password, private_key FROM servers WHERE id IN (${targetPodIds.map(() => '?').join(',')})`,
    targetPodIds
  );

  const colNames = masterColumns.map(c => c.column_name);
  const colListStr = colNames.map(c => `"${c}"`).join(', ');
  const conflictCol = colNames.includes('key') ? 'key' : (colNames.includes('topic') ? 'topic' : pkColumn);
  const updateSet = colNames
    .filter(c => c !== conflictCol && c !== 'id')
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  const values = colNames.map(c => singleRow[c]);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

  let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
  if (updateSet) {
    upsertSql += ` ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet}`;
  } else {
    upsertSql += ` ON CONFLICT ("${conflictCol}") DO NOTHING`;
  }

  const results = [];

  for (const pod of targetPods) {
    const podResult = {
      serverId: pod.id,
      serverName: pod.name,
      success: false,
      syncedRow: singleRow,
      error: null
    };

    // Try Direct PG
    try {
      const client = new Client({
        connectionString: getPodDbUrl(pod.host),
        connectionTimeoutMillis: 3000,
        statement_timeout: 10000
      });
      await client.connect();
      try {
        // Ensure missing columns exist
        const podColumns = await getTableColumnsFromClient(client, tableName);
        for (const mc of masterColumns) {
          const exists = podColumns.some(pc => pc.column_name === mc.column_name);
          if (!exists) {
            await client.query(`ALTER TABLE public."${tableName}" ADD COLUMN IF NOT EXISTS "${mc.column_name}" ${mc.data_type};`);
          }
        }

        await client.query("SET LOCAL session_replication_role = 'replica';").catch(() => { });
        await client.query(upsertSql, values);
        podResult.success = true;
      } finally {
        await client.end().catch(() => { });
      }
    } catch (directErr) {
      // SSH Fallback
      try {
        const escapedValues = colNames.map(c => {
          const val = singleRow[c];
          if (val === null || val === undefined) return 'NULL';
          if (typeof val === 'number') return val;
          if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
          return `'${String(val).replace(/'/g, "''")}'`;
        }).join(', ');

        let sshUpsert = `INSERT INTO public.\\"${tableName}\\" (${colNames.map(c => `\\"${c}\\"`).join(', ')}) VALUES (${escapedValues})`;
        if (updateSet) {
          const sshUpdateSet = colNames
            .filter(c => c !== conflictCol && c !== 'id')
            .map(c => `\\"${c}\\" = EXCLUDED.\\"${c}\\"`)
            .join(', ');
          sshUpsert += ` ON CONFLICT (\\"${conflictCol}\\") DO UPDATE SET ${sshUpdateSet};`;
        } else {
          sshUpsert += ` ON CONFLICT (\\"${conflictCol}\\") DO NOTHING;`;
        }

        await executeSshCommand(pod, `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -c "${sshUpsert}"`);
        podResult.success = true;
      } catch (sshErr) {
        podResult.success = false;
        podResult.error = sshErr.message;
      }
    }

    results.push(podResult);
  }

  return {
    success: true,
    masterId,
    tableName,
    pkColumn,
    pkValue,
    totalTargets: targetPods.length,
    successfulTargets: results.filter(r => r.success).length,
    results
  };
}

/**
 * 8. Pull Table Data from a single POD to Master Database (POD ➔ Master)
 */
async function syncPodTableToMaster({
  masterId,
  serverId,
  tableName,
  dryRun = false,
  dateFrom = null,
  dateTo = null
}) {
  if (!masterId || !serverId || !tableName) {
    throw new Error('masterId, serverId, dan tableName wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!pod) throw new Error('Server POD tidak ditemukan.');

  const masterClient = createMasterClient(master);
  await masterClient.connect();

  let masterColumns = [];
  let pkColumn = 'id';
  try {
    masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    if (masterColumns.length === 0) {
      throw new Error(`Tabel '${tableName}' tidak ditemukan pada Master Database '${master.name}'.`);
    }

    const pkQuery = `
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = $1;
    `;
    const pkRes = await masterClient.query(pkQuery, [tableName]);
    if (pkRes.rows.length > 0) pkColumn = pkRes.rows[0].column_name;
    else pkColumn = masterColumns[0].column_name;
  } catch (err) {
    await masterClient.end().catch(() => { });
    throw err;
  }

  const colNames = Array.from(new Set(masterColumns.map(c => c.column_name)));
  const conflictCol = colNames.includes('key') ? 'key' : (colNames.includes('topic') ? 'topic' : pkColumn);
  const updateSet = colNames
    .filter(c => c !== conflictCol && c !== 'id')
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  // Fetch rows from POD
  let podRows = [];
  try {
    const podClient = new Client({
      connectionString: getPodDbUrl(pod.host),
      connectionTimeoutMillis: 8000,
      statement_timeout: 45000
    });
    await podClient.connect();
    try {
      let query = `SELECT * FROM public."${tableName}"`;
      const conditions = [];
      const params = [];

      if (dateFrom) {
        params.push(dateFrom);
        conditions.push(`("created_at" >= $${params.length} OR "created_date" >= $${params.length})`);
      }
      if (dateTo) {
        params.push(dateTo);
        conditions.push(`("created_at" <= $${params.length} OR "created_date" <= $${params.length})`);
      }

      if (conditions.length > 0) {
        query += ` WHERE ${conditions.join(' AND ')}`;
      }
      query += ` ORDER BY "${pkColumn}" ASC LIMIT 10000`;

      const res = await podClient.query(query, params);
      podRows = res.rows;
    } finally {
      await podClient.end().catch(() => { });
    }
  } catch (directErr) {
    // SSH Fallback
    try {
      let filterClause = '';
      if (dateFrom && dateTo) {
        filterClause = ` WHERE created_at BETWEEN '${dateFrom}' AND '${dateTo}'`;
      }
      const dataCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT json_agg(t) FROM (SELECT * FROM public.\\"${tableName}\\"${filterClause} ORDER BY \\"${pkColumn}\\" ASC LIMIT 10000) t;"`;
      const dataRaw = await executeSshCommand(pod, dataCmd);
      try { podRows = JSON.parse(dataRaw || '[]'); } catch (e) { podRows = []; }
    } catch (sshErr) {
      await masterClient.end().catch(() => { });
      throw new Error(`Gagal mengambil data dari POD ${pod.name}: ${sshErr.message}`);
    }
  }

  let rowsProcessed = 0;
  const logs = [];

  try {
    if (!dryRun && podRows.length > 0) {
      await masterClient.query('BEGIN');
      await masterClient.query("SET LOCAL session_replication_role = 'replica';");

      rowsProcessed = await executeBatchUpsert({
        client: masterClient,
        tableName,
        colNames,
        rows: podRows,
        conflictCol,
        updateSet,
        batchSize: 150
      });

      await masterClient.query('COMMIT');
    } else if (dryRun) {
      rowsProcessed = podRows.length;
    }

    logs.push(`[Selesai] ${dryRun ? 'Simulasi' : 'Tarik data batch'} berhasil: ${rowsProcessed} baris dari ${pod.name} disinkronkan ke Master DB.`);
  } catch (err) {
    if (!dryRun) {
      await masterClient.query('ROLLBACK').catch(() => { });
    }
    throw err;
  } finally {
    await masterClient.end().catch(() => { });
  }

  return {
    success: true,
    masterId,
    serverId,
    serverName: pod.name,
    tableName,
    dryRun,
    totalRowsFromPod: podRows.length,
    rowsProcessed,
    logs
  };
}

/**
 * 9. Sync Single Row from POD to Master Database (POD ➔ Master)
 */
async function syncSinglePodRowToMaster({
  masterId,
  serverId,
  serverIds,
  tableName,
  pkColumn = 'id',
  pkValue
}) {
  const targetServerIds = Array.isArray(serverIds) && serverIds.length > 0
    ? serverIds.map(Number)
    : (serverId ? [Number(serverId)] : []);

  if (!masterId || targetServerIds.length === 0 || !tableName || pkValue === undefined) {
    throw new Error('masterId, serverId/serverIds, tableName, dan pkValue wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  let singleRow = null;
  let sourcePod = null;

  for (const sId of targetServerIds) {
    const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sId]);
    if (!pod) continue;

    // 1. Fetch from POD (Direct PG or SSH)
    try {
      const podClient = new Client({
        connectionString: getPodDbUrl(pod.host),
        connectionTimeoutMillis: 3000,
        statement_timeout: 6000
      });
      await podClient.connect();
      try {
        const res = await podClient.query(`SELECT * FROM public."${tableName}" WHERE "${pkColumn}"::text = $1::text LIMIT 1;`, [String(pkValue)]);
        if (res.rows.length > 0) {
          singleRow = res.rows[0];
          sourcePod = pod;
          break;
        }
      } finally {
        await podClient.end().catch(() => { });
      }
    } catch (directErr) {
      // SSH Fallback
      try {
        const sshCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT json_agg(t) FROM (SELECT * FROM public.\\"${tableName}\\" WHERE \\"${pkColumn}\\"::text='${String(pkValue).replace(/'/g, "''")}' LIMIT 1) t;"`;
        const raw = await executeSshCommand(pod, sshCmd);
        try {
          const parsed = JSON.parse(raw || '[]');
          if (parsed.length > 0) {
            singleRow = parsed[0];
            sourcePod = pod;
            break;
          }
        } catch (err) { }
      } catch (sshErr) { }
    }
  }

  if (!singleRow) {
    throw new Error(`Baris dengan ${pkColumn} = '${pkValue}' tidak ditemukan pada database unit POD.`);
  }

  // 2. Upsert into Master DB
  const masterClient = createMasterClient(master);
  await masterClient.connect();
  try {
    const masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    const colNames = Array.from(new Set(masterColumns.map(c => c.column_name)));
    const colListStr = colNames.map(c => `"${c}"`).join(', ');
    const conflictCol = colNames.includes('key') ? 'key' : (colNames.includes('topic') ? 'topic' : pkColumn);
    const updateSet = colNames
      .filter(c => c !== conflictCol && c !== 'id')
      .map(c => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');

    const values = colNames.map(c => singleRow[c] !== undefined ? singleRow[c] : null);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

    let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
    if (updateSet) {
      upsertSql += ` ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet}`;
    } else {
      upsertSql += ` ON CONFLICT ("${conflictCol}") DO NOTHING`;
    }

    await masterClient.query('BEGIN');
    await masterClient.query("SET LOCAL session_replication_role = 'replica';");
    await masterClient.query(upsertSql, values);
    await masterClient.query('COMMIT');

    return {
      success: true,
      masterId,
      serverId: sourcePod?.id || targetServerIds[0],
      serverName: sourcePod?.name || 'POD',
      tableName,
      pkColumn,
      pkValue,
      syncedRow: singleRow
    };
  } catch (err) {
    await masterClient.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    await masterClient.end().catch(() => { });
  }
}

module.exports = {
  getMasterDatabases,
  getMasterTables,
  compareMasterTableAcrossPods,
  syncMasterTableToPods,
  deleteMasterTableRow,
  deletePodTableRow,
  syncSingleMasterRowToPods,
  syncPodTableToMaster,
  syncSinglePodRowToMaster
};

