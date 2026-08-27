const { Client } = require('pg');
const net = require('net');
const dbAsync = require('../db');
const { executeSshCommand } = require('../../utils/sshExecutor');
const { decrypt } = require('../../utils/crypto');

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
 * Helper to get table column metadata from a connected pg Client
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

module.exports = {
  POD_DB_USER,
  POD_DB_PASS,
  POD_DB_NAME,
  POD_DB_PORT,
  checkTcpConnection,
  getPodDbUrl,
  createMasterClient,
  getTableConflictColumns,
  filterRowsForPod,
  getCached,
  setCached,
  clearSchemaCache,
  runWithConcurrencyLimit,
  getPodUuidMap,
  getTableColumnsFromClient,
  executeBatchUpsert,
  fetchPodTableInfo
};
