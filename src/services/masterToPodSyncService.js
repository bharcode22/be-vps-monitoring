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
    connectionTimeoutMillis: 6000,
    statement_timeout: 15000
  });
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
 * 2. Fetch public tables and their row counts from selected Master Database
 */
async function getMasterTables(masterId) {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error(`Database Master dengan ID ${masterId} tidak ditemukan.`);

  const client = createMasterClient(master);
  await client.connect();
  try {
    const query = `
      SELECT 
        table_name,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.table_name) as column_count
      FROM information_schema.tables t
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT LIKE '_prisma%'
        AND table_name NOT LIKE 'spatial_ref_sys'
      ORDER BY table_name ASC;
    `;
    const res = await client.query(query);

    const tablesWithRows = [];
    for (const row of res.rows) {
      try {
        const countRes = await client.query(`SELECT COUNT(*) as cnt FROM public."${row.table_name}"`);
        tablesWithRows.push({
          tableName: row.table_name,
          columnCount: parseInt(row.column_count, 10),
          rowCount: parseInt(countRes.rows[0].cnt, 10)
        });
      } catch (cntErr) {
        tablesWithRows.push({
          tableName: row.table_name,
          columnCount: parseInt(row.column_count, 10),
          rowCount: 0
        });
      }
    }
    return {
      master: { id: master.id, name: master.name, host: master.host, dbName: master.db_name },
      tables: tablesWithRows
    };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Fetch table columns info from a PG connection
 */
async function getTableColumnsFromClient(client, tableName) {
  const query = `
    SELECT 
      column_name,
      data_type,
      is_nullable,
      column_default,
      character_maximum_length
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position ASC;
  `;
  const res = await client.query(query, [tableName]);
  return res.rows;
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
      connectionTimeoutMillis: 3000,
      statement_timeout: 6000
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
      await client.end().catch(() => {});
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
    await masterClient.end().catch(() => {});
  }

  // 2. Fetch all POD V3 servers
  const podV3List = await dbAsync.all(
    "SELECT id, name, host, port, username, password, private_key FROM servers WHERE pod_version = 'v3' ORDER BY name ASC"
  );

  // 3. Query all PODs in parallel
  const podResults = await Promise.all(
    podV3List.map(pod => fetchPodTableInfo(pod, tableName))
  );

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

  // 5. Build Data Row Matrix
  // Unique comparison identifier for rows
  const getRowKey = (row) => {
    if (row.key) return String(row.key);
    if (row.topic) return String(row.topic);
    if (row.code) return String(row.code);
    if (row[masterPkColumn] !== undefined) return String(row[masterPkColumn]);
    return JSON.stringify(row);
  };

  const dataMatrix = masterRows.map((masterRow, idx) => {
    const rowKey = getRowKey(masterRow);
    const presenceByPod = {};
    let presentCount = 0;

    for (const pod of podV3List) {
      const podRes = podResults.find(r => r.serverId === pod.id);
      if (!podRes || !podRes.isOnline) {
        presenceByPod[pod.id] = { isOnline: false, present: false };
      } else if (!podRes.tableExists) {
        presenceByPod[pod.id] = { isOnline: true, present: false };
      } else {
        const found = podRes.rows.some(pr => getRowKey(pr) === rowKey);
        if (found) {
          presenceByPod[pod.id] = { isOnline: true, present: true };
          presentCount++;
        } else {
          presenceByPod[pod.id] = { isOnline: true, present: false };
        }
      }
    }

    return {
      rowKey,
      sampleData: masterRow,
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
      isAllSynced: onlinePodsCount > 0 && syncedPodsCount === onlinePodsCount
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
    await masterClient.end().catch(() => {});
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

        // B. Upsert Master Rows
        if (syncData && masterRows.length > 0) {
          const colNames = masterColumns.map(c => c.column_name);
          const colListStr = colNames.map(c => `"${c}"`).join(', ');

          // Determine conflict target (PK column or unique key)
          const conflictCol = colNames.includes('key') ? 'key' : (colNames.includes('topic') ? 'topic' : pkColumn);
          const updateSet = colNames
            .filter(c => c !== conflictCol && c !== 'id')
            .map(c => `"${c}" = EXCLUDED."${c}"`)
            .join(', ');

          for (const row of masterRows) {
            const values = colNames.map(c => row[c]);
            const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');

            let upsertSql = `INSERT INTO public."${tableName}" (${colListStr}) VALUES (${placeholders})`;
            if (updateSet) {
              upsertSql += ` ON CONFLICT ("${conflictCol}") DO UPDATE SET ${updateSet}`;
            } else {
              upsertSql += ` ON CONFLICT ("${conflictCol}") DO NOTHING`;
            }

            if (!dryRun) {
              await client.query(upsertSql, values);
            }
            podResult.rowsSynced++;
          }
        }

        if (!dryRun) {
          await client.query('COMMIT');
        }

        podResult.success = true;
        podResult.logs.push(`[Completed] ${dryRun ? 'Simulasi' : 'Sinkronisasi'} sukses: ${podResult.rowsSynced} baris data diproses.`);
      } catch (execErr) {
        if (!dryRun) {
          await client.query('ROLLBACK').catch(() => {});
        }
        throw execErr;
      } finally {
        await client.end().catch(() => {});
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

module.exports = {
  getMasterDatabases,
  getMasterTables,
  compareMasterTableAcrossPods,
  syncMasterTableToPods
};
