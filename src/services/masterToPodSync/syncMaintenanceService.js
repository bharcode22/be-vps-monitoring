const { Client } = require('pg');
const dbAsync = require('../db');
const { executeSshCommand } = require('../../utils/sshExecutor');
const {
  POD_DB_USER,
  POD_DB_NAME,
  getPodDbUrl,
  createMasterClient
} = require('./syncHelpers');
const { findChildRelations } = require('./syncMetadataService');

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
  deleteMasterTableRow,
  deletePodTableRow,
  cleanMasterDuplicates,
  checkMasterDuplicates
};
