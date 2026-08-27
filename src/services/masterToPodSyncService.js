const { Client } = require('pg');
const net = require('net');
const dbAsync = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');
const { decrypt } = require('../utils/crypto');

const POD_DB_USER = process.env.POD_DB_USER || 'development';
const POD_DB_PASS = process.env.POD_DB_PASS || 'development';
const POD_DB_NAME = process.env.POD_DB_NAME || 'regenesis';
const POD_DB_PORT = parseInt(process.env.POD_DB_PORT || '5432', 10);

/**
 * Fast TCP connection probe (500-1000ms timeout)
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

    socket.connect(port || 22, host);
  });
}

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
 * Helper to determine unique conflict key columns for tables.
 * targetType: 'pod' | 'master'
 * - When writing to POD: POD DB has compound FK unique constraints like (fk_user_id, fk_question_id).
 * - When writing to Master: Master DB does NOT have compound unique constraints on these tables,
 *   so Master uses the primary key (pkColumn / id) or natural keys like key/topic.
 */
function getTableConflictColumns(tableName, colNames = [], pkColumn = 'id', targetType = 'pod') {
  if (targetType === 'master') {
    if (colNames.includes('key')) return ['key'];
    if (colNames.includes('topic')) return ['topic'];
    return [pkColumn || 'id'];
  }

  // When writing to POD
  if (tableName === 'terms_and_conditions_answers') {
    if (colNames.includes('fk_user_id') && colNames.includes('fk_question_id')) {
      return ['fk_user_id', 'fk_question_id'];
    }
  }
  if (tableName === 'terms_and_conditions_accepted') {
    if (colNames.includes('fk_user_id') && colNames.includes('fk_terms_and_conditions_version_id')) {
      return ['fk_user_id', 'fk_terms_and_conditions_version_id'];
    }
  }
  if (tableName === 'terms_and_conditions_version_question') {
    if (colNames.includes('fk_terms_and_conditions_version_id') && colNames.includes('fk_question_id')) {
      return ['fk_terms_and_conditions_version_id', 'fk_question_id'];
    }
  }
  if (tableName === 'terms_and_conditions_question_bundle') {
    if (colNames.includes('fk_question_id') && colNames.includes('fk_terms_and_conditions_version_id')) {
      return ['fk_question_id', 'fk_terms_and_conditions_version_id'];
    }
  }
  if (colNames.includes('key')) return ['key'];
  if (colNames.includes('topic')) return ['topic'];
  return [pkColumn || 'id'];
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

  const conflictColsArray = Array.isArray(conflictCol) ? conflictCol : [conflictCol];
  const conflictStr = conflictColsArray.map(c => `"${c.trim()}"`).join(', ');

  // Sort rows to prioritize latest answer_date / updated_at / created_at / id before deduplication
  const sortedRows = [...rows].sort((a, b) => {
    if (a.answer_date && b.answer_date) return new Date(a.answer_date) - new Date(b.answer_date);
    if (a.accepted_date && b.accepted_date) return new Date(a.accepted_date) - new Date(b.accepted_date);
    if (a.updated_at && b.updated_at) return new Date(a.updated_at) - new Date(b.updated_at);
    if (a.created_at && b.created_at) return new Date(a.created_at) - new Date(b.created_at);
    if (a.id && b.id) return a.id - b.id;
    return 0;
  });

  const deduplicatedMap = new Map();
  for (const row of sortedRows) {
    const key = conflictColsArray.map(c => row[c]).join('_|||_');
    deduplicatedMap.set(key, row);
  }
  const uniqueRows = Array.from(deduplicatedMap.values());

  let processedCount = 0;

  for (let i = 0; i < uniqueRows.length; i += batchSize) {
    const chunk = uniqueRows.slice(i, i + batchSize);
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
      upsertSql += ` ON CONFLICT (${conflictStr}) DO UPDATE SET ${updateSet}`;
    } else {
      upsertSql += ` ON CONFLICT (${conflictStr}) DO NOTHING`;
    }

    try {
      await client.query(upsertSql, values);
    } catch (upsertErr) {
      if (
        upsertErr.code === '42P10' ||
        (upsertErr.message && upsertErr.message.includes('no unique or exclusion constraint'))
      ) {
        // Fallback: try using pkColumn ('id') or plain INSERT
        const fallbackPk = uniqueCols.includes('id') ? 'id' : uniqueCols[0];
        const fallbackUpdateSet = uniqueCols.filter(c => c !== fallbackPk).map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');
        let fallbackSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES ${valuePlaceholders.join(', ')}`;
        if (fallbackUpdateSet) {
          fallbackSql += ` ON CONFLICT ("${fallbackPk}") DO UPDATE SET ${fallbackUpdateSet}`;
        } else {
          fallbackSql += ` ON CONFLICT ("${fallbackPk}") DO NOTHING`;
        }
        await client.query(fallbackSql, values);
      } else {
        throw upsertErr;
      }
    }
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
 * 2B. Fast Master Table Inspection (Instant < 50ms)
 * Loads Master schema and rows, plus all POD V3 server info in idle NOT_LOADED state.
 */
async function getMasterTableFast(masterId, tableName) {
  if (!masterId || !tableName) throw new Error('Master Database ID dan Nama Tabel wajib diisi.');

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

  const podV3List = await dbAsync.all(
    "SELECT id, name, host, port, username, password, private_key FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
  );

  const getRowKeyHelper = (row) => {
    if (!row) return '';
    if (row.key) return String(row.key);
    if (row.topic) return String(row.topic);
    if (row.code) return String(row.code);
    if (row[masterPkColumn] !== undefined) return String(row[masterPkColumn]);
    return JSON.stringify(row);
  };

  const columnMatrix = masterColumns.map(col => ({
    columnName: col.column_name,
    dataType: col.data_type,
    isNullable: col.is_nullable,
    isPk: col.column_name === masterPkColumn,
    presence: {},
    presentCount: 0,
    totalPods: podV3List.length
  }));

  const dataMatrix = masterRows.map(mr => {
    const key = getRowKeyHelper(mr);
    return {
      rowKey: key,
      sampleData: mr,
      inMaster: true,
      isPodOnly: false,
      originPodId: null,
      originPodName: null,
      originPodHost: null,
      podSources: [],
      podIds: [],
      podSourcesDetail: [],
      presence: {},
      presentCount: 0,
      totalPods: podV3List.length
    };
  });

  // Fast parallel TCP probe to detect real-time Online / Offline status for all PODs (1s timeout)
  const probeResults = await Promise.all(
    podV3List.map(async (pod) => {
      const isOnline = await checkTcpConnection(pod.host, pod.port || 22, 1000);
      return { id: pod.id, isOnline };
    })
  );
  const onlineMap = new Map(probeResults.map(r => [r.id, r.isOnline]));

  const podSummaries = podV3List.map(pod => {
    const isOnline = onlineMap.get(pod.id) ?? false;
    return {
      id: pod.id,
      name: pod.name,
      host: pod.host,
      isOnline,
      tableExists: null,
      rowCount: null,
      status: isOnline ? 'NOT_LOADED' : 'OFFLINE',
      missingColumnsCount: 0,
      missingRowsCount: 0,
      missingColumns: [],
      missingRowsSample: []
    };
  });

  const onlineCount = podSummaries.filter(p => p.isOnline).length;

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
      onlinePods: onlineCount,
      syncedPods: 0,
      mismatchPods: 0,
      isAllSynced: false,
      podOnlyRowsCount: 0
    }
  };
}

/**
 * 2C. Compare Master Table against a Single Specific POD V3 Server (~200ms)
 */
async function compareMasterTableWithSinglePod(masterId, tableName, podId) {
  if (!masterId || !tableName || !podId) {
    throw new Error('Master DB ID, Nama Tabel, dan POD ID wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const podServer = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [podId]);
  if (!podServer) throw new Error('POD Server tidak ditemukan.');

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

  const getRowKeyHelper = (row) => {
    if (!row) return '';
    if (row.key) return String(row.key);
    if (row.topic) return String(row.topic);
    if (row.code) return String(row.code);
    if (row[masterPkColumn] !== undefined) return String(row[masterPkColumn]);
    return JSON.stringify(row);
  };

  // Query ONLY this specific POD
  const podRes = await fetchPodTableInfo(podServer, tableName);

  let podSummary = {};
  const columnPresenceMap = {};
  const dataPresenceMap = {};
  const podOnlyRows = [];

  if (!podRes.isOnline) {
    podSummary = {
      id: podServer.id,
      name: podServer.name,
      host: podServer.host,
      isOnline: false,
      tableExists: false,
      rowCount: 0,
      status: 'OFFLINE',
      missingColumnsCount: masterColumns.length,
      missingRowsCount: masterRowCount,
      missingColumns: [],
      missingRowsSample: [],
      rows: [],
      columns: []
    };
  } else if (!podRes.tableExists) {
    podSummary = {
      id: podServer.id,
      name: podServer.name,
      host: podServer.host,
      isOnline: true,
      tableExists: false,
      rowCount: 0,
      status: 'TABLE_MISSING',
      missingColumnsCount: masterColumns.length,
      missingRowsCount: masterRowCount,
      missingColumns: masterColumns.map(c => c.column_name),
      missingRowsSample: [],
      rows: [],
      columns: []
    };
  } else {
    // 1. Columns check
    for (const col of masterColumns) {
      const podCol = (podRes.columns || []).find(c => c.column_name === col.column_name);
      if (podCol) {
        columnPresenceMap[col.column_name] = {
          isOnline: true,
          exists: true,
          typeMatch: podCol.data_type === col.data_type,
          podType: podCol.data_type
        };
      } else {
        columnPresenceMap[col.column_name] = {
          isOnline: true,
          exists: false,
          typeMatch: false
        };
      }
    }

    const missingCols = masterColumns.filter(mc => !columnPresenceMap[mc.column_name]?.exists);

    // 2. Data rows check
    const podRowKeySet = new Set((podRes.rows || []).map(r => getRowKeyHelper(r)));

    for (const mr of masterRows) {
      const key = getRowKeyHelper(mr);
      const isPresent = podRowKeySet.has(key);
      dataPresenceMap[key] = {
        isOnline: true,
        present: isPresent
      };
    }

    const missingRows = masterRows.filter(mr => !podRowKeySet.has(getRowKeyHelper(mr)));

    // 3. Pod-only rows (in POD but not in Master sample)
    const masterRowKeySet = new Set(masterRows.map(mr => getRowKeyHelper(mr)));
    for (const pr of (podRes.rows || [])) {
      const key = getRowKeyHelper(pr);
      if (!masterRowKeySet.has(key)) {
        podOnlyRows.push({
          rowKey: key,
          sampleData: pr,
          inMaster: false,
          isPodOnly: true,
          originPodId: podServer.id,
          originPodName: podServer.name,
          originPodHost: podServer.host,
          podSources: [podServer.name],
          podIds: [podServer.id],
          podSourcesDetail: [`${podServer.name} (${podServer.host})`],
          presence: {
            [podServer.id]: { isOnline: true, present: true }
          },
          presentCount: 1,
          totalPods: 1
        });
      }
    }

    // Verify if podOnlyRows are actually in Master (for tables > 500 rows)
    if (podOnlyRows.length > 0) {
      const pkVals = podOnlyRows.map(r => r.sampleData[masterPkColumn]).filter(v => v !== undefined && v !== null);
      if (pkVals.length > 0) {
        const verifyClient = createMasterClient(master);
        await verifyClient.connect();
        try {
          const verifyQuery = `SELECT "${masterPkColumn}" FROM public."${tableName}" WHERE "${masterPkColumn}" = ANY($1)`;
          const verifyRes = await verifyClient.query(verifyQuery, [pkVals]);
          if (verifyRes.rows.length > 0) {
            const verifiedSet = new Set(verifyRes.rows.map(r => String(r[masterPkColumn])));
            for (const item of podOnlyRows) {
              if (verifiedSet.has(String(item.sampleData[masterPkColumn]))) {
                item.inMaster = true;
                item.isPodOnly = false;
              }
            }
          }
        } catch (err) {
          console.error(`[Single POD Verify Error]:`, err.message);
        } finally {
          await verifyClient.end().catch(() => { });
        }
      }
    }

    let status = 'SYNCED';
    if (missingCols.length > 0) status = 'COLUMN_MISMATCH';
    else if (missingRows.length > 0 || podRes.rowCount !== masterRowCount) status = 'ROW_MISMATCH';

    podSummary = {
      id: podServer.id,
      name: podServer.name,
      host: podServer.host,
      isOnline: true,
      tableExists: true,
      rowCount: podRes.rowCount,
      status,
      missingColumnsCount: missingCols.length,
      missingRowsCount: missingRows.length,
      missingColumns: missingCols.map(c => c.column_name),
      missingRowsSample: missingRows.slice(0, 10).map(r => getRowKeyHelper(r)),
      rows: podRes.rows || [],
      columns: podRes.columns || []
    };
  }

  return {
    success: true,
    podId: podServer.id,
    podSummary,
    columnPresenceMap,
    dataPresenceMap,
    podOnlyRows
  };
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

  // 🚀 HARD VERIFICATION FOR MASTER DB
  // This completely fixes the "Fake Missing in Master" bug caused by LIMIT 500 when tables have > 500 rows.
  // We explicitly ask Master if it actually has these PKs before marking them as truly missing.
  const missingInMasterKeys = Array.from(allRowsMap.values())
    .filter(item => !item.inMaster)
    .map(item => item.sampleData && item.sampleData[masterPkColumn])
    .filter(val => val !== undefined && val !== null);

  if (missingInMasterKeys.length > 0) {
    const masterClientVerification = createMasterClient(master);
    await masterClientVerification.connect();
    try {
      // Process in chunks to prevent query size limit issues
      for (let i = 0; i < missingInMasterKeys.length; i += 1000) {
        const chunk = missingInMasterKeys.slice(i, i + 1000);
        // Cast the array to the correct type of the column dynamically, or rely on PG auto-casting
        // ANY($1) usually auto-casts from string arrays to uuid arrays if the column is uuid
        const verifyQuery = `SELECT "${masterPkColumn}" FROM public."${tableName}" WHERE "${masterPkColumn}" = ANY($1)`;
        const verifyRes = await masterClientVerification.query(verifyQuery, [chunk]);

        if (verifyRes.rows && verifyRes.rows.length > 0) {
          const verifiedPkSet = new Set(verifyRes.rows.map(r => String(r[masterPkColumn])));
          for (const item of allRowsMap.values()) {
            if (!item.inMaster) {
              const pk = item.sampleData && item.sampleData[masterPkColumn];
              if (pk !== undefined && verifiedPkSet.has(String(pk))) {
                item.inMaster = true; // ✅ Data actually exists in Master, just wasn't in the top 500!
              }
            }
          }
        }
      }
    } catch (err) {
      console.error(`[Matrix Sync] Error verifying missing master rows for ${tableName}:`, err.message);
    } finally {
      await masterClientVerification.end().catch(() => { });
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
          const conflictCols = getTableConflictColumns(tableName, colNames, pkColumn);
          const conflictColsArray = Array.isArray(conflictCols) ? conflictCols : [conflictCols];
          const updateSet = colNames
            .filter(c => !conflictColsArray.includes(c) && c !== 'id')
            .map(c => `"${c}" = EXCLUDED."${c}"`)
            .join(', ');

          if (!dryRun) {
            const syncedCount = await executeBatchUpsert({
              client,
              tableName,
              colNames,
              rows: rowsToSync,
              conflictCol: conflictColsArray,
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
  const conflictCols = getTableConflictColumns(tableName, colNames, pkColumn);
  const conflictStr = conflictCols.map(c => `"${c.trim()}"`).join(', ');
  const updateSet = colNames
    .filter(c => !conflictCols.includes(c) && c !== 'id')
    .map(c => `"${c}" = EXCLUDED."${c}"`)
    .join(', ');

  const values = colNames.map(c => singleRow[c]);
  const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

  let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
  if (updateSet) {
    upsertSql += ` ON CONFLICT (${conflictStr}) DO UPDATE SET ${updateSet}`;
  } else {
    upsertSql += ` ON CONFLICT (${conflictStr}) DO NOTHING`;
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

        const sshConflictStr = conflictCols.map(c => `\\\\"${c.trim()}\\\\"`).join(', ');
        let sshUpsert = `INSERT INTO public.\\"${tableName}\\" (${colNames.map(c => `\\"${c}\\"`).join(', ')}) VALUES (${escapedValues})`;
        if (updateSet) {
          const sshUpdateSet = colNames
            .filter(c => !conflictCols.includes(c) && c !== 'id')
            .map(c => `\\"${c}\\" = EXCLUDED.\\"${c}\\"`)
            .join(', ');
          sshUpsert += ` ON CONFLICT (${sshConflictStr}) DO UPDATE SET ${sshUpdateSet};`;
        } else {
          sshUpsert += ` ON CONFLICT (${sshConflictStr}) DO NOTHING;`;
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
  const conflictCols = getTableConflictColumns(tableName, colNames, pkColumn, 'master');
  const conflictColsArray = Array.isArray(conflictCols) ? conflictCols : [conflictCols];
  const updateSet = colNames
    .filter(c => !conflictColsArray.includes(c) && c !== 'id')
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
        conflictCol: conflictColsArray,
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
  pkValue,
  rowData
}) {
  const targetServerIds = Array.isArray(serverIds) && serverIds.length > 0
    ? serverIds.map(Number)
    : (serverId ? [Number(serverId)] : []);

  if (!masterId || !tableName || (pkValue === undefined && !rowData)) {
    throw new Error('masterId, tableName, dan pkValue/rowData wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  let singleRow = null;
  let sourcePod = null;

  // 1. If rowData is directly provided, clean and use it
  if (rowData && typeof rowData === 'object') {
    singleRow = { ...rowData };
    Object.keys(singleRow).forEach(k => {
      if (k.startsWith('__')) delete singleRow[k];
    });
  }

  // 2. Otherwise fetch from POD
  if (!singleRow) {
    for (const sId of targetServerIds) {
      const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sId]);
      if (!pod) continue;

      // Direct PG
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
  }

  if (!singleRow) {
    throw new Error(`Baris dengan ${pkColumn} = '${pkValue}' tidak ditemukan.`);
  }

  // 3. Upsert into Master DB
  const masterClient = createMasterClient(master);
  await masterClient.connect();
  try {
    const masterColumns = await getTableColumnsFromClient(masterClient, tableName);
    const colNames = Array.from(new Set(masterColumns.map(c => c.column_name)));
    const colListStr = colNames.map(c => `"${c}"`).join(', ');

    const conflictCols = getTableConflictColumns(tableName, colNames, pkColumn, 'master');
    const conflictStr = conflictCols.map(c => `"${c.trim()}"`).join(', ');

    const updateSet = colNames
      .filter(c => !conflictCols.includes(c) && c !== 'id')
      .map(c => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');

    const values = colNames.map(c => singleRow[c] !== undefined ? singleRow[c] : null);
    const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

    let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
    if (updateSet) {
      upsertSql += ` ON CONFLICT (${conflictStr}) DO UPDATE SET ${updateSet}`;
    } else {
      upsertSql += ` ON CONFLICT (${conflictStr}) DO NOTHING`;
    }

    await masterClient.query('BEGIN');
    await masterClient.query("SET LOCAL session_replication_role = 'replica';");
    try {
      await masterClient.query(upsertSql, values);
    } catch (upsertErr) {
      // If table (e.g. pod_logs) has no unique constraint matching conflictCol, fallback to direct INSERT
      if (
        upsertErr.message &&
        (upsertErr.message.includes('no unique or exclusion constraint') ||
          upsertErr.message.includes('ON CONFLICT DO UPDATE') ||
          upsertErr.code === '42P10')
      ) {
        const plainInsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
        await masterClient.query(plainInsertSql, values);
      } else {
        throw upsertErr;
      }
    }
    await masterClient.query('COMMIT');

    clearSchemaCache(masterId);

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

/**
 * Ultra-Fast Single-Query Fleet Table Counts for a POD Server
 * Returns a map of all public base tables on this POD with their row counts & column counts in < 15ms
 */
async function fetchPodFleetTableCounts(podServer) {
  const host = podServer.host;
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

  // 1. Direct PG
  try {
    const client = new Client({
      connectionString: getPodDbUrl(host),
      connectionTimeoutMillis: 2500,
      statement_timeout: 4000
    });

    await client.connect();
    try {
      const res = await client.query(singleQuery);
      const tablesMap = {};
      res.rows.forEach(r => {
        tablesMap[r.table_name] = {
          tableExists: true,
          columnCount: parseInt(r.column_count, 10) || 0,
          rowCount: Math.max(0, parseInt(r.row_count, 10) || 0)
        };
      });
      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: true,
        tablesMap
      };
    } finally {
      await client.end().catch(() => { });
    }
  } catch (directErr) {
    // 2. SSH Fallback
    try {
      const psqlCmd = `psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "SELECT json_object_agg(t.table_name, json_build_object('columnCount', t.column_count, 'rowCount', t.row_count)) FROM (SELECT t.table_name, (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name=t.table_name) as column_count, COALESCE(s.n_live_tup, c.reltuples::bigint, 0) as row_count FROM information_schema.tables t LEFT JOIN pg_stat_user_tables s ON s.relname=t.table_name AND s.schemaname='public' LEFT JOIN pg_class c ON c.relname=t.table_name AND c.relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public') WHERE t.table_schema='public' AND t.table_type='BASE TABLE' AND t.table_name NOT LIKE '_prisma%' AND t.table_name NOT LIKE 'spatial_ref_sys') t;"`;
      const psqlRaw = await executeSshCommand(podServer, psqlCmd);
      let tablesMap = {};
      try {
        tablesMap = JSON.parse(psqlRaw || '{}');
      } catch (e) {
        tablesMap = {};
      }
      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: true,
        tablesMap
      };
    } catch (sshErr) {
      return {
        serverId: podServer.id,
        serverName: podServer.name,
        isOnline: false,
        tablesMap: {}
      };
    }
  }
}

/**
 * Fleet-Wide Discrepancy & Health Audit across all 95 Tables and all PODs
 * Scans the entire fleet in < 1.5 seconds using Concurrency Pooled single-query metadata
 */
async function auditFleetDiscrepancies(masterId) {
  if (!masterId) throw new Error('Master Database ID wajib diisi.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error(`Database Master dengan ID ${masterId} tidak ditemukan.`);

  // 1. Fetch Master Tables in single query
  const masterTablesRes = await getMasterTables(masterId);
  const masterTables = masterTablesRes.tables || [];

  // 2. Fetch all POD V3 servers
  const podV3List = await dbAsync.all(
    "SELECT id, name, host, port, username, password, private_key FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
  );

  // 3. Scan all PODs in parallel using Concurrency Pool (8 workers)
  const taskFns = podV3List.map(pod => () => fetchPodFleetTableCounts(pod));
  const podResults = await runWithConcurrencyLimit(taskFns, 8);

  const onlinePods = podResults.filter(p => p.isOnline);
  const onlinePodsCount = onlinePods.length;
  const totalPodsCount = podV3List.length;

  let totalDeltaRows = 0;
  let syncedTablesCount = 0;
  let discrepantTablesCount = 0;
  let missingTablesCount = 0;

  const tableAudits = masterTables.map(mTable => {
    const tName = mTable.tableName;
    const masterRows = mTable.rowCount || 0;
    const isPartitioned = tName === 'pod';

    let syncedPodsForTable = 0;
    let missingInPodsForTable = 0;
    let tableDeltaRows = 0;
    const podBreakdown = [];

    for (const pod of podV3List) {
      const podRes = podResults.find(r => r.serverId === pod.id);
      if (!podRes || !podRes.isOnline) {
        podBreakdown.push({
          podId: pod.id,
          podName: pod.name,
          podHost: pod.host,
          isOnline: false,
          tableExists: false,
          podRowCount: 0,
          delta: 0,
          isSynced: false,
          status: 'offline'
        });
        continue;
      }

      const podTableInfo = podRes.tablesMap?.[tName];
      if (!podTableInfo) {
        missingInPodsForTable++;
        tableDeltaRows += masterRows;
        podBreakdown.push({
          podId: pod.id,
          podName: pod.name,
          podHost: pod.host,
          isOnline: true,
          tableExists: false,
          podRowCount: 0,
          delta: -masterRows,
          isSynced: false,
          status: 'missing_table'
        });
      } else {
        const podRows = podTableInfo.rowCount || 0;
        let delta = 0;
        let isSynced = false;

        if (isPartitioned) {
          // Partitioned fleet table (each POD should have exactly 1 row)
          isSynced = podRows === 1;
          delta = podRows - 1;
        } else {
          delta = podRows - masterRows;
          isSynced = delta === 0;
        }

        if (isSynced) {
          syncedPodsForTable++;
        } else {
          tableDeltaRows += Math.abs(delta);
        }

        podBreakdown.push({
          podId: pod.id,
          podName: pod.name,
          podHost: pod.host,
          isOnline: true,
          tableExists: true,
          podRowCount: podRows,
          delta,
          isSynced,
          status: isSynced ? 'synced' : (delta < 0 ? 'behind' : 'ahead')
        });
      }
    }

    const isAllSynced = onlinePodsCount > 0 && syncedPodsForTable === onlinePodsCount;
    const hasMissingTables = missingInPodsForTable > 0;
    const syncPercentage = onlinePodsCount > 0 ? Math.round((syncedPodsForTable / onlinePodsCount) * 100) : 0;

    if (isAllSynced) {
      syncedTablesCount++;
    } else if (hasMissingTables) {
      missingTablesCount++;
    } else {
      discrepantTablesCount++;
    }

    totalDeltaRows += tableDeltaRows;

    return {
      tableName: tName,
      columnCount: mTable.columnCount || 0,
      masterRowCount: masterRows,
      relationType: mTable.relationType || 'standalone',
      parents: mTable.parents || [],
      children: mTable.children || [],
      isPartitioned,
      isAllSynced,
      hasMissingTables,
      syncPercentage,
      syncedPodsCount: syncedPodsForTable,
      onlinePodsCount,
      totalPodsCount,
      tableDeltaRows,
      missingPodsCount: missingInPodsForTable,
      podBreakdown
    };
  });

  return {
    master: { id: master.id, name: master.name, host: master.host, dbName: master.db_name },
    summary: {
      totalTables: masterTables.length,
      syncedTables: syncedTablesCount,
      discrepantTables: discrepantTablesCount,
      missingTables: missingTablesCount,
      totalDeltaRows,
      fleetSyncPercentage: masterTables.length > 0 ? Math.round((syncedTablesCount / masterTables.length) * 100) : 0,
      onlinePodsCount,
      totalPodsCount
    },
    tables: tableAudits,
    scannedAt: new Date().toISOString()
  };
}

/**
 * 2B. Fetch Dynamic Relational FK Tree for a selected table
 * Returns parents (dependencies) and children (dependents) with their live row counts
 */
async function getTableRelations(masterId, tableName) {
  if (!masterId || !tableName) throw new Error('Master ID dan Nama Tabel wajib diisi.');

  const masterTablesRes = await getMasterTables(masterId);
  const allTables = masterTablesRes.tables || [];

  const mainTable = allTables.find(t => t.tableName === tableName);
  if (!mainTable) throw new Error(`Tabel '${tableName}' tidak ditemukan pada Master Database.`);

  // 1. Map Parent tables (Dependencies that must exist first)
  const parents = (mainTable.parents || []).map(p => {
    const parentTableInfo = allTables.find(t => t.tableName === p.foreignTableName);
    return {
      tableName: p.foreignTableName,
      role: 'parent',
      foreignKeyCol: p.columnName,
      referencedCol: p.foreignColumnName,
      columnCount: parentTableInfo?.columnCount || 0,
      rowCount: parentTableInfo?.rowCount || 0,
      relationType: parentTableInfo?.relationType || 'standalone'
    };
  });

  // 2. Map Child tables (Dependents that reference mainTable)
  const children = (mainTable.children || []).map(c => {
    const childTableInfo = allTables.find(t => t.tableName === c.tableName);
    return {
      tableName: c.tableName,
      role: 'child',
      foreignKeyCol: c.columnName,
      referencedCol: c.foreignColumnName,
      columnCount: childTableInfo?.columnCount || 0,
      rowCount: childTableInfo?.rowCount || 0,
      relationType: childTableInfo?.relationType || 'standalone'
    };
  });

  // Deduplicate parents and children by tableName
  const uniqueParents = [];
  const parentMap = new Set();
  parents.forEach(p => {
    if (!parentMap.has(p.tableName)) {
      parentMap.add(p.tableName);
      uniqueParents.push(p);
    }
  });

  const uniqueChildren = [];
  const childMap = new Set();
  children.forEach(c => {
    if (!childMap.has(c.tableName)) {
      childMap.add(c.tableName);
      uniqueChildren.push(c);
    }
  });

  return {
    master: masterTablesRes.master,
    primaryTable: {
      tableName: mainTable.tableName,
      role: 'primary',
      columnCount: mainTable.columnCount,
      rowCount: mainTable.rowCount,
      relationType: mainTable.relationType
    },
    parents: uniqueParents,
    children: uniqueChildren,
    suggestedExecutionOrder: [
      ...uniqueParents.map(p => p.tableName),
      mainTable.tableName,
      ...uniqueChildren.map(c => c.tableName)
    ]
  };
}

/**
 * 4B. Dynamic Relational Sync: Syncs an ordered set of related tables (Parents -> Primary -> Children)
 * to target PODs in safe topological sequence.
 */
async function syncRelationalTablesToPods({
  masterId,
  primaryTable,
  tablesToSync = [],
  targetPodIds = [],
  dryRun = false,
  syncColumns = true,
  syncData = true
}) {
  if (!masterId || !tablesToSync || tablesToSync.length === 0 || targetPodIds.length === 0) {
    throw new Error('Master DB, Daftar Tabel Berelasi, dan Target POD wajib ditentukan.');
  }

  // Normalize tablesToSync to list of { tableName, role }
  const normalizedTables = tablesToSync.map(item => {
    if (typeof item === 'string') {
      const isPrimary = item === primaryTable;
      return { tableName: item, role: isPrimary ? 'primary' : 'related' };
    }
    return item;
  });

  const tableReports = [];
  let totalRowsSynced = 0;

  for (const t of normalizedTables) {
    try {
      const singleTableResult = await syncMasterTableToPods({
        masterId,
        tableName: t.tableName,
        targetPodIds,
        dryRun,
        syncColumns,
        syncData
      });

      const rowsCount = singleTableResult.results?.reduce((acc, r) => acc + (r.rowsSynced || 0), 0) || 0;
      totalRowsSynced += rowsCount;

      tableReports.push({
        tableName: t.tableName,
        role: t.role || (t.tableName === primaryTable ? 'primary' : 'related'),
        success: singleTableResult.success !== false,
        successfulTargets: singleTableResult.successfulTargets || 0,
        failedTargets: singleTableResult.failedTargets || 0,
        totalRowsSynced: rowsCount,
        results: singleTableResult.results || []
      });
    } catch (err) {
      tableReports.push({
        tableName: t.tableName,
        role: t.role || 'related',
        success: false,
        successfulTargets: 0,
        failedTargets: targetPodIds.length,
        totalRowsSynced: 0,
        error: err.message
      });
    }
  }

  // Clear cache for updated master
  clearSchemaCache(masterId);

  return {
    success: tableReports.every(r => r.success),
    dryRun,
    masterId,
    primaryTable: primaryTable || normalizedTables[0]?.tableName,
    syncedTablesCount: tableReports.filter(r => r.success).length,
    totalTablesCount: normalizedTables.length,
    tableReports,
    totalRowsSynced
  };
}

/**
 * Clean Duplicate Data from Master Database
 * Automatically archives duplicate rows to [tableName]_history if a history table exists (e.g. terms_and_conditions_answers_history)
 * Also purges & archives answers for inactive/deleted/obsolete questions when cleaning terms_and_conditions_answers!
 */
async function cleanMasterDuplicates(masterId, tableName, conflictColsArray) {
  if (!masterId || !tableName || !conflictColsArray || conflictColsArray.length === 0) {
    throw new Error('Master DB, Nama Tabel, dan Kolom Unik wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  let deletedCount = 0;
  let archivedCount = 0;
  let obsoleteCount = 0;
  let duplicateDeletedCount = 0;
  let historyTableName = null;

  try {
    const colsStr = conflictColsArray.map(c => `"${c.trim()}"`).join(', ');

    // 1. Check if corresponding history table exists in Master DB
    const candidateHistoryTable = `${tableName}_history`;
    const checkHistRes = await client.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name = $1`,
      [candidateHistoryTable]
    );

    if (checkHistRes.rows.length > 0) {
      historyTableName = candidateHistoryTable;
    }

    await client.query('BEGIN');

    // Get common columns between main table and history table
    let commonColsStr = '';
    if (historyTableName) {
      const mainColsRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [tableName]
      );
      const histColsRes = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`,
        [historyTableName]
      );

      const histColSet = new Set(histColsRes.rows.map(c => c.column_name));
      // Exclude 'id' so history table sequence / default generates new ID without collision
      const commonCols = mainColsRes.rows
        .map(c => c.column_name)
        .filter(c => histColSet.has(c) && c !== 'id');

      if (commonCols.length > 0) {
        commonColsStr = commonCols.map(c => `"${c}"`).join(', ');
      }
    }

    // 2. Specialized Step for terms_and_conditions_answers:
    // Purge and archive answers belonging to obsolete / inactive / deleted questions
    if (tableName === 'terms_and_conditions_answers') {
      const hasQuestionsTable = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'terms_and_conditions_questions'
      `);

      if (hasQuestionsTable.rows.length > 0) {
        const obsoleteWhereClause = `
          "fk_question_id" NOT IN (
            SELECT "id" FROM public."terms_and_conditions_questions"
            WHERE "active" = true AND "deleted_at" IS NULL
          )
        `;

        if (historyTableName && commonColsStr) {
          const archiveObsoleteSql = `
            INSERT INTO public."${historyTableName}" (${commonColsStr})
            SELECT ${commonColsStr}
            FROM public."${tableName}"
            WHERE ${obsoleteWhereClause};
          `;
          const archRes = await client.query(archiveObsoleteSql);
          obsoleteCount = archRes.rowCount;
          archivedCount += archRes.rowCount;
        }

        const deleteObsoleteSql = `
          DELETE FROM public."${tableName}"
          WHERE ${obsoleteWhereClause};
        `;
        const delRes = await client.query(deleteObsoleteSql);
        deletedCount += delRes.rowCount;
      }
    }

    // 3. Archive & Deduplicate user duplicates (preserving the latest row with max(ctid))
    if (historyTableName && commonColsStr) {
      const archiveSql = `
        INSERT INTO public."${historyTableName}" (${commonColsStr})
        SELECT ${commonColsStr}
        FROM public."${tableName}"
        WHERE ctid NOT IN (
          SELECT max(ctid)
          FROM public."${tableName}"
          GROUP BY ${colsStr}
        );
      `;
      const archRes = await client.query(archiveSql);
      archivedCount += archRes.rowCount;
    }

    const deleteSql = `
      DELETE FROM public."${tableName}"
      WHERE ctid NOT IN (
        SELECT max(ctid)
        FROM public."${tableName}"
        GROUP BY ${colsStr}
      );
    `;

    const res = await client.query(deleteSql);
    duplicateDeletedCount = res.rowCount;
    deletedCount += res.rowCount;

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => { });
    throw err;
  } finally {
    await client.end().catch(() => { });
  }

  return { 
    success: true, 
    deletedCount, 
    archivedCount, 
    obsoleteCount,
    duplicateDeletedCount,
    historyTableName 
  };
}

/**
 * Check Duplicate Data from Master Database
 * Also checks for obsolete/inactive question answers for terms_and_conditions_answers
 */
async function checkMasterDuplicates(masterId, tableName, conflictColsArray) {
  if (!masterId || !tableName || !conflictColsArray || conflictColsArray.length === 0) {
    throw new Error('Master DB, Nama Tabel, dan Kolom Unik wajib diisi.');
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    const colsStr = conflictColsArray.map(c => `"${c.trim()}"`).join(', ');

    let obsoleteCount = 0;
    let obsoleteSampleRows = [];

    // If checking terms_and_conditions_answers, also inspect obsolete questions
    if (tableName === 'terms_and_conditions_answers') {
      const hasQuestionsTable = await client.query(`
        SELECT table_name FROM information_schema.tables 
        WHERE table_schema = 'public' AND table_name = 'terms_and_conditions_questions'
      `);

      if (hasQuestionsTable.rows.length > 0) {
        const obsoleteRes = await client.query(`
          SELECT fk_question_id, COUNT(*) as cnt
          FROM public."${tableName}"
          WHERE "fk_question_id" NOT IN (
            SELECT "id" FROM public."terms_and_conditions_questions"
            WHERE "active" = true AND "deleted_at" IS NULL
          )
          GROUP BY fk_question_id;
        `);
        obsoleteSampleRows = obsoleteRes.rows;
        obsoleteCount = obsoleteRes.rows.reduce((acc, r) => acc + parseInt(r.cnt, 10), 0);
      }
    }

    const sampleQuery = `
      SELECT ${colsStr}, COUNT(*) as duplicate_count
      FROM public."${tableName}"
      GROUP BY ${colsStr}
      HAVING COUNT(*) > 1
      ORDER BY duplicate_count DESC
      LIMIT 5
    `;

    const totalsQuery = `
      WITH DuplicateGroups AS (
        SELECT COUNT(*) as cnt
        FROM public."${tableName}"
        GROUP BY ${colsStr}
        HAVING COUNT(*) > 1
      )
      SELECT 
        COALESCE(SUM(cnt), 0) as total_duplicate_rows, 
        COALESCE(SUM(cnt - 1), 0) as rows_to_delete
      FROM DuplicateGroups
    `;

    const [sampleRes, totalsRes] = await Promise.all([
      client.query(sampleQuery),
      client.query(totalsQuery)
    ]);

    const totals = totalsRes.rows[0] || { total_duplicate_rows: 0, rows_to_delete: 0 };
    const duplicateRowsToDelete = parseInt(totals.rows_to_delete, 10);
    const totalRowsToDelete = duplicateRowsToDelete + obsoleteCount;

    return {
      success: true,
      hasDuplicates: totalRowsToDelete > 0,
      totalDuplicateRows: parseInt(totals.total_duplicate_rows, 10),
      rowsToDelete: totalRowsToDelete,
      duplicateRowsToDelete,
      obsoleteCount,
      obsoleteSampleRows,
      sampleRows: sampleRes.rows
    };
  } finally {
    await client.end().catch(() => { });
  }
}

module.exports = {
  getMasterDatabases,
  getMasterTables,
  getTableRelations,
  getMasterTableFast,
  compareMasterTableWithSinglePod,
  compareMasterTableAcrossPods,
  syncMasterTableToPods,
  syncRelationalTablesToPods,
  deleteMasterTableRow,
  deletePodTableRow,
  syncSingleMasterRowToPods,
  syncPodTableToMaster,
  syncSinglePodRowToMaster,
  auditFleetDiscrepancies,
  checkMasterDuplicates,
  cleanMasterDuplicates,
  clearSchemaCache
};

