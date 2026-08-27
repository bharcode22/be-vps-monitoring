const dbAsync = require('../db');
const {
  createMasterClient,
  checkTcpConnection,
  getCached,
  setCached,
  getPodUuidMap,
  getTableColumnsFromClient
} = require('./syncHelpers');

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
    "SELECT id, name, host, port, username, password, private_key, pod_uuid, code FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
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
      pod_uuid: pod.pod_uuid,
      code: pod.code,
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
  const podUuidMap = await getPodUuidMap();

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
    podUuidMap,
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

module.exports = {
  getMasterDatabases,
  getMasterTables,
  getMasterTableFast,
  findChildRelations,
  getTableRelations
};
