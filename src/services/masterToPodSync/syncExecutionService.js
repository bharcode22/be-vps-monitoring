const { Client } = require('pg');
const dbAsync = require('../db');
const { executeSshCommand } = require('../../utils/sshExecutor');
const {
  POD_DB_USER,
  POD_DB_NAME,
  getPodDbUrl,
  createMasterClient,
  getTableConflictColumns,
  filterRowsForPod,
  getTableColumnsFromClient,
  executeBatchUpsert,
  clearSchemaCache
} = require('./syncHelpers');

/**
 * 4. Broadcast Sync Master Table to Selected PODs
 */
async function syncMasterTableToPods({
  masterId,
  tableName,
  targetPodIds = [],
  dryRun = false,
  syncColumns = true,
  syncData = true
}) {
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
 * Sync Single Row from Master to Target PODs
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

module.exports = {
  syncMasterTableToPods,
  syncSingleMasterRowToPods,
  syncPodTableToMaster,
  syncSinglePodRowToMaster,
  syncRelationalTablesToPods
};
