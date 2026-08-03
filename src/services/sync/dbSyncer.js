const { Pool } = require('pg');

const DEFAULT_BATCH_SIZE = 500;

/**
 * Execute synchronization between source and target database connections
 */
async function performSync(options) {
  const {
    sourceUrl,
    targetUrl,
    dryRun = false,
    tables = null, // null for all tables or Array of table names
    batchSize = DEFAULT_BATCH_SIZE
  } = options;

  const startTime = Date.now();
  const sourcePool = new Pool({ connectionString: sourceUrl });
  const targetPool = new Pool({ connectionString: targetUrl });

  const logs = [];
  const log = (msg) => logs.push(`[${new Date().toISOString()}] ${msg}`);

  log(`Starting DB sync. DryRun: ${dryRun}`);

  const sourceClient = await sourcePool.connect();
  const targetClient = await targetPool.connect();

  const details = [];
  let totalRowsSynced = 0;

  try {
    // Fetch user tables from source
    const sourceTablesRes = await sourceClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('spatial_ref_sys')
      ORDER BY table_name;
    `);
    const sourceTables = sourceTablesRes.rows.map(r => r.table_name);

    // Fetch user tables from target
    const targetTablesRes = await targetClient.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('spatial_ref_sys')
    `);
    const targetTables = new Set(targetTablesRes.rows.map(r => r.table_name));

    let tablesToSync = sourceTables;
    if (Array.isArray(tables) && tables.length > 0) {
      tablesToSync = sourceTables.filter(t => tables.includes(t));
    }

    if (!dryRun) {
      log('Disabling foreign key constraints on target database...');
      await targetClient.query("SET session_replication_role = 'replica';");
    }

    for (const tableName of tablesToSync) {
      if (!targetTables.has(tableName)) {
        details.push({
          tableName,
          status: 'skipped',
          reason: 'Table does not exist in target database',
          rowsSynced: 0
        });
        continue;
      }

      // Fetch columns
      const colsRes = await sourceClient.query(`
        SELECT column_name 
        FROM information_schema.columns 
        WHERE table_schema = 'public' AND table_name = $1
        ORDER BY ordinal_position;
      `, [tableName]);
      const columns = colsRes.rows.map(r => r.column_name);

      if (columns.length === 0) {
        details.push({
          tableName,
          status: 'skipped',
          reason: 'No columns found',
          rowsSynced: 0
        });
        continue;
      }

      // Count source rows
      const countRes = await sourceClient.query(`SELECT COUNT(*) as cnt FROM "${tableName}"`);
      const totalRows = parseInt(countRes.rows[0].cnt, 10);

      if (totalRows === 0) {
        details.push({
          tableName,
          status: 'success',
          reason: 'Empty table',
          rowsSynced: 0
        });
        continue;
      }

      const colNamesStr = columns.map(c => `"${c}"`).join(', ');

      if (!dryRun) {
        await targetClient.query(`TRUNCATE TABLE "${tableName}" CASCADE;`);
      }

      let copiedRows = 0;
      let offset = 0;

      while (offset < totalRows) {
        const sourceData = await sourceClient.query(
          `SELECT ${colNamesStr} FROM "${tableName}" LIMIT ${batchSize} OFFSET ${offset}`
        );

        if (sourceData.rows.length === 0) break;

        if (!dryRun) {
          const values = [];
          const valuePlaceholders = [];
          let paramIndex = 1;

          for (const row of sourceData.rows) {
            const rowPlaceholders = [];
            for (const col of columns) {
              values.push(row[col]);
              rowPlaceholders.push(`$${paramIndex++}`);
            }
            valuePlaceholders.push(`(${rowPlaceholders.join(', ')})`);
          }

          const insertQuery = `INSERT INTO "${tableName}" (${colNamesStr}) VALUES ${valuePlaceholders.join(', ')}`;
          await targetClient.query(insertQuery, values);
        }

        copiedRows += sourceData.rows.length;
        offset += batchSize;
      }

      // Reset auto-increment sequence if ID column exists
      if (!dryRun && columns.includes('id')) {
        try {
          await targetClient.query(`
            SELECT setval(
              pg_get_serial_sequence('"${tableName}"', 'id'),
              COALESCE((SELECT MAX(id) FROM "${tableName}"), 1),
              true
            );
          `);
        } catch (e) {
          // Ignore sequence reset error for non-serial IDs
        }
      }

      totalRowsSynced += copiedRows;
      details.push({
        tableName,
        status: 'success',
        rowsSynced: copiedRows,
        totalSourceRows: totalRows
      });
    }

    if (!dryRun) {
      log('Re-enabling foreign key constraints on target database...');
      await targetClient.query("SET session_replication_role = 'origin';");
    }

    const durationMs = Date.now() - startTime;
    log(`Sync finished in ${durationMs}ms. Total rows: ${totalRowsSynced}`);

    return {
      success: true,
      dryRun,
      durationMs,
      totalTablesSynced: details.filter(d => d.status === 'success').length,
      totalRowsSynced,
      details,
      logs
    };

  } catch (err) {
    if (!dryRun) {
      try {
        await targetClient.query("SET session_replication_role = 'origin';");
      } catch (e) {}
    }
    throw err;
  } finally {
    sourceClient.release();
    targetClient.release();
    await sourcePool.end();
    await targetPool.end();
  }
}

module.exports = { performSync };
