const { Client, Pool } = require('pg');

/**
 * Parse host & db info from connection string for logging/display
 */
function parseUrlInfo(url) {
  try {
    const parsed = new URL(url);
    return {
      database: parsed.pathname.replace('/', '') || 'unknown',
      user: parsed.username || 'unknown',
      host: `${parsed.hostname}:${parsed.port || 5432}`
    };
  } catch (e) {
    return { database: 'unknown', user: 'unknown', host: 'unknown' };
  }
}

/**
 * Test database connection
 */
async function testConnection(connectionString) {
  const startTime = Date.now();
  const client = new Client({ connectionString });
  try {
    await client.connect();
    const res = await client.query('SELECT current_database(), current_user, version()');
    const duration = Date.now() - startTime;
    await client.end();

    const info = parseUrlInfo(connectionString);

    return {
      success: true,
      database: res.rows[0].current_database,
      user: res.rows[0].current_user,
      version: res.rows[0].version.split(',')[0],
      host: info.host,
      latencyMs: duration
    };
  } catch (err) {
    try { await client.end(); } catch (e) {}
    return {
      success: false,
      error: err.message,
      host: parseUrlInfo(connectionString).host
    };
  }
}

/**
 * Get schema information for all base tables in public schema
 */
async function getSchemaInfo(pool) {
  const tablesQuery = `
    SELECT table_name 
    FROM information_schema.tables 
    WHERE table_schema = 'public' 
      AND table_type = 'BASE TABLE'
      AND table_name NOT IN ('spatial_ref_sys')
    ORDER BY table_name;
  `;
  const tablesRes = await pool.query(tablesQuery);
  const tables = tablesRes.rows.map(r => r.table_name);

  const columnsQuery = `
    SELECT 
      table_name,
      column_name, 
      data_type, 
      udt_name,
      is_nullable,
      character_maximum_length
    FROM information_schema.columns 
    WHERE table_schema = 'public'
    ORDER BY table_name, ordinal_position;
  `;
  const colsRes = await pool.query(columnsQuery);

  const tableColumns = {};
  for (const row of colsRes.rows) {
    if (!tableColumns[row.table_name]) {
      tableColumns[row.table_name] = [];
    }
    tableColumns[row.table_name].push({
      name: row.column_name,
      type: row.udt_name || row.data_type,
      nullable: row.is_nullable === 'YES',
      maxLength: row.character_maximum_length
    });
  }

  // Row counts
  const rowCounts = {};
  for (const table of tables) {
    try {
      const cntRes = await pool.query(`SELECT COUNT(*) as cnt FROM "${table}"`);
      rowCounts[table] = parseInt(cntRes.rows[0].cnt, 10);
    } catch (e) {
      rowCounts[table] = 0;
    }
  }

  return { tables, tableColumns, rowCounts };
}

/**
 * Compare schema between Source and Target DBs
 */
async function compareSchemas(sourceUrl, targetUrl) {
  const sourcePool = new Pool({ connectionString: sourceUrl });
  const targetPool = new Pool({ connectionString: targetUrl });

  try {
    const sourceSchema = await getSchemaInfo(sourcePool);
    const targetSchema = await getSchemaInfo(targetPool);

    const missingInTarget = [];
    const extraInTarget = [];
    const differentSchema = [];
    const identical = [];

    const sourceTablesSet = new Set(sourceSchema.tables);
    const targetTablesSet = new Set(targetSchema.tables);

    // Check source tables
    for (const table of sourceSchema.tables) {
      if (!targetTablesSet.has(table)) {
        missingInTarget.push({
          tableName: table,
          sourceRowCount: sourceSchema.rowCounts[table] || 0
        });
      } else {
        // Compare columns
        const sourceCols = sourceSchema.tableColumns[table] || [];
        const targetCols = targetSchema.tableColumns[table] || [];

        const sourceColMap = new Map(sourceCols.map(c => [c.name, c]));
        const targetColMap = new Map(targetCols.map(c => [c.name, c]));

        const differences = [];

        // Check for missing/changed columns
        for (const [colName, sCol] of sourceColMap) {
          if (!targetColMap.has(colName)) {
            differences.push({
              type: 'MISSING_COLUMN_IN_TARGET',
              column: colName,
              detail: `Column "${colName}" (${sCol.type}) exists in Source but is missing in Target.`
            });
          } else {
            const tCol = targetColMap.get(colName);
            if (sCol.type !== tCol.type) {
              differences.push({
                type: 'TYPE_MISMATCH',
                column: colName,
                detail: `Column "${colName}" data type mismatch: Source (${sCol.type}) vs Target (${tCol.type}).`
              });
            }
            if (sCol.nullable !== tCol.nullable) {
              differences.push({
                type: 'NULLABLE_MISMATCH',
                column: colName,
                detail: `Column "${colName}" nullable mismatch: Source (${sCol.nullable ? 'NULL' : 'NOT NULL'}) vs Target (${tCol.nullable ? 'NULL' : 'NOT NULL'}).`
              });
            }
          }
        }

        // Check for extra columns in target
        for (const [colName, tCol] of targetColMap) {
          if (!sourceColMap.has(colName)) {
            differences.push({
              type: 'EXTRA_COLUMN_IN_TARGET',
              column: colName,
              detail: `Column "${colName}" (${tCol.type}) exists in Target but not in Source.`
            });
          }
        }

        if (differences.length > 0) {
          differentSchema.push({
            tableName: table,
            sourceRowCount: sourceSchema.rowCounts[table] || 0,
            targetRowCount: targetSchema.rowCounts[table] || 0,
            differences
          });
        } else {
          identical.push({
            tableName: table,
            sourceRowCount: sourceSchema.rowCounts[table] || 0,
            targetRowCount: targetSchema.rowCounts[table] || 0,
            columnsCount: sourceCols.length
          });
        }
      }
    }

    // Check extra tables in target
    for (const table of targetSchema.tables) {
      if (!sourceTablesSet.has(table)) {
        extraInTarget.push({
          tableName: table,
          targetRowCount: targetSchema.rowCounts[table] || 0
        });
      }
    }

    return {
      success: true,
      summary: {
        totalSourceTables: sourceSchema.tables.length,
        totalTargetTables: targetSchema.tables.length,
        identicalCount: identical.length,
        differentSchemaCount: differentSchema.length,
        missingInTargetCount: missingInTarget.length,
        extraInTargetCount: extraInTarget.length
      },
      missingInTarget,
      extraInTarget,
      differentSchema,
      identical
    };
  } finally {
    await sourcePool.end();
    await targetPool.end();
  }
}

module.exports = {
  testConnection,
  compareSchemas
};
