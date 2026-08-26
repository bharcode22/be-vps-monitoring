const { Client } = require('pg');
const { dbAsync } = require('./db');
const { decrypt } = require('../utils/crypto');

const ALLOWED_TABLES = [
  'terms_and_conditions_version',
  'terms_and_conditions_questions',
  'terms_and_conditions_question_bundle',
  'terms_and_conditions_question_history',
  'terms_and_conditions_version_question',
  'terms_and_conditions',
  'user',
  'matrix_user',
  'matrix_user_history',
  'terms_and_conditions_accepted',
  'terms_and_conditions_accepted_history',
  'terms_and_conditions_answers',
  'terms_and_conditions_answers_history'
];

function createMasterClient(masterConfig) {
  return new Client({
    host: masterConfig.host,
    port: masterConfig.port || 5432,
    user: masterConfig.db_user,
    password: decrypt(masterConfig.password),
    database: masterConfig.db_name,
    ssl: { rejectUnauthorized: false }
  });
}

/**
 * Fetch table schema and all data from Master DB
 */
async function getMasterTableData(masterId, tableName) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Table ${tableName} is not allowed for CRUD operations.`);
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    // 1. Get Primary Key
    const pkRes = await client.query(`
      SELECT a.attname AS column_name
      FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary;
    `, [tableName]);
    const pkColumn = pkRes.rows.length > 0 ? pkRes.rows[0].column_name : null;

    // 2. Get Column Schema
    const schemaRes = await client.query(`
      SELECT column_name, data_type, column_default, is_nullable
      FROM information_schema.columns
      WHERE table_name = $1
      ORDER BY ordinal_position;
    `, [tableName]);

    let columns = schemaRes.rows.map(r => ({
      name: r.column_name,
      type: r.data_type,
      default: r.column_default,
      nullable: r.is_nullable === 'YES',
      isPk: r.column_name === pkColumn
    }));

    let query = `SELECT * FROM public."${tableName}"`;

    if (pkColumn) {
      query += ` ORDER BY "${pkColumn}" DESC`;
    }
    query += ` LIMIT 1000`;

    const dataRes = await client.query(query);

    return {
      tableName,
      pkColumn,
      columns,
      rows: dataRes.rows,
      totalCount: dataRes.rowCount // approximate for limit 1000
    };
  } finally {
    await client.end().catch(() => { });
  }
}

const { randomUUID } = require('crypto');

async function recordHistory(client, tableName, newRow, actionType = 'CREATE') {
  const changeType = actionType;

  if (tableName === 'terms_and_conditions_questions') {
    const historyQuery = `
      INSERT INTO public."terms_and_conditions_question_history" 
      ("id", "fk_question_id", "active", "created_date", "information", "change_type", "tooltip", "question_version", "question")
      VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8)
    `;
    await client.query(historyQuery, [
      randomUUID(),
      newRow.id,
      newRow.active,
      newRow.information,
      changeType,
      newRow.tooltip,
      newRow.version,
      newRow.question
    ]);
  } else if (tableName === 'matrix_user') {
    const historyQuery = `
      INSERT INTO public."matrix_user_history"
      ("id", "fk_matrix_user_id", "fk_question_id", "stroboscopic_light", "audio_surround_sound", "vibro_acoustics", "led_intensity", "led_color", "infra_red_nea_ir", "infra_red_far_ir", "pemf_therapy", "olfactory_engagement", "binaural_beats_isochronic_tones", "direct_neutral_stimulation", "fk_task", "created_at")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
    `;
    await client.query(historyQuery, [
      randomUUID(),
      newRow.id, // fk_matrix_user_id
      newRow.fk_question_id,
      newRow.stroboscopic_light,
      newRow.audio_surround_sound,
      newRow.vibro_acoustics,
      newRow.led_intensity,
      newRow.led_color,
      newRow.infra_red_nea_ir,
      newRow.infra_red_far_ir,
      newRow.pemf_therapy,
      newRow.olfactory_engagement,
      newRow.binaural_beats_isochronic_tones,
      newRow.direct_neutral_stimulation,
      newRow.fk_task
    ]);
  } else if (tableName === 'terms_and_conditions') {
    const historyQuery = `
      INSERT INTO public."terms_and_conditions_version"
      ("id", "version_code", "title", "terms_and_conditions", "change_log", "created_date", "is_active", "is_major_change")
      VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7)
    `;
    await client.query(historyQuery, [
      randomUUID(),
      newRow.version,
      `Auto Update: ${newRow.version}`,
      newRow.terms_and_conditions,
      `Automated ${changeType} via Manager`,
      newRow.active,
      false
    ]);
  }
}

async function getNextVersion(client, tableName) {
  try {
    const res = await client.query(`SELECT version FROM public."${tableName}" WHERE version ~ '^v[0-9]+$'`);
    let max = 0;
    for (const row of res.rows) {
      if (!row.version) continue;
      const num = parseInt(row.version.substring(1), 10);
      if (!isNaN(num) && num > max) max = num;
    }
    return `v${max + 1}`;
  } catch (err) {
    return 'v1';
  }
}

/**
 * Insert a new row into Master DB
 */
async function createMasterRow(masterId, tableName, data) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Table ${tableName} is not allowed for CRUD operations.`);
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    await client.query('BEGIN');

    // Auto-generate version for relevant tables
    if (tableName === 'terms_and_conditions' || tableName === 'terms_and_conditions_questions') {
      data.version = await getNextVersion(client, tableName);
    }

    const keys = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== '');
    if (keys.length === 0) throw new Error('Tidak ada data yang dikirim.');

    const columns = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => data[k]);

    const query = `INSERT INTO public."${tableName}" (${columns}) VALUES (${placeholders}) RETURNING *`;
    const res = await client.query(query, values);
    const newRow = res.rows[0];

    // Auto History Log
    await recordHistory(client, tableName, newRow, 'CREATE');

    await client.query('COMMIT');
    return newRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Update an existing row in Master DB
 */
async function updateMasterRow(masterId, tableName, pkColumn, pkValue, data) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Table ${tableName} is not allowed for CRUD operations.`);
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    await client.query('BEGIN');

    // Auto-generate version for relevant tables
    if (tableName === 'terms_and_conditions' || tableName === 'terms_and_conditions_questions') {
      data.version = await getNextVersion(client, tableName);
    }

    // Exclude primary key from update data just in case
    const updateData = { ...data };
    delete updateData[pkColumn];

    const keys = Object.keys(updateData).filter(k => updateData[k] !== undefined && updateData[k] !== '');
    if (keys.length === 0) throw new Error('Tidak ada data yang diperbarui.');

    const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
    const values = keys.map(k => updateData[k]);

    // Add pkValue as the last parameter
    values.push(pkValue);

    const query = `UPDATE public."${tableName}" SET ${setClause} WHERE "${pkColumn}" = $${values.length} RETURNING *`;
    const res = await client.query(query, values);

    if (res.rowCount === 0) {
      throw new Error('Data tidak ditemukan atau gagal diupdate.');
    }

    const updatedRow = res.rows[0];

    // Auto History Log
    await recordHistory(client, tableName, updatedRow, 'UPDATE');

    await client.query('COMMIT');
    return updatedRow;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Delete a row from Master DB
 */
async function deleteMasterRow(masterId, tableName, pkColumn, pkValue) {
  if (!ALLOWED_TABLES.includes(tableName)) {
    throw new Error(`Table ${tableName} is not allowed for CRUD operations.`);
  }

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    await client.query('BEGIN');

    // First fetch the row to log to history
    const selectQuery = `SELECT * FROM public."${tableName}" WHERE "${pkColumn}" = $1`;
    const selectRes = await client.query(selectQuery, [pkValue]);
    if (selectRes.rowCount === 0) {
      throw new Error('Data tidak ditemukan.');
    }
    const rowToDelete = selectRes.rows[0];

    // Log deletion to history (use the before-delete state)
    await recordHistory(client, tableName, rowToDelete, 'DELETE');

    // Perform hard delete
    const deleteQuery = `DELETE FROM public."${tableName}" WHERE "${pkColumn}" = $1`;
    await client.query(deleteQuery, [pkValue]);

    await client.query('COMMIT');
    return { success: true, deletedId: pkValue };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Validate that matrix_user fk_question_ids match the currently active terms_and_conditions_questions
 */
async function validateMatrixQuestions(masterId) {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    // 1. Get active question IDs
    const activeQuestionsRes = await client.query(`
      SELECT id FROM public."terms_and_conditions_questions" 
      WHERE active = true AND deleted_at IS NULL
    `);
    const activeIds = new Set(activeQuestionsRes.rows.map(r => r.id));

    // 2. Get matrix user question IDs
    const matrixRes = await client.query(`
      SELECT DISTINCT fk_question_id FROM public."matrix_user"
      WHERE deleted_at IS NULL
    `);
    const matrixIds = new Set(matrixRes.rows.map(r => r.fk_question_id));

    const missingInMatrix = [...activeIds].filter(id => !matrixIds.has(id));
    const outdatedInMatrix = [...matrixIds].filter(id => !activeIds.has(id));

    if (missingInMatrix.length === 0 && outdatedInMatrix.length === 0) {
      return { isValid: true };
    }

    let warningMsg = 'Peringatan Ketidaksesuaian Relasi: ';
    if (outdatedInMatrix.length > 0) {
      warningMsg += `Terdapat fk_question_id di matrix_user yang merujuk pada pertanyaan tidak aktif atau terhapus (ID: ${outdatedInMatrix.join(', ')}). `;
    }
    if (missingInMatrix.length > 0) {
      warningMsg += `Ada pertanyaan aktif baru yang belum ada di matrix_user (ID: ${missingInMatrix.join(', ')}). `;
    }

    return {
      isValid: false,
      message: warningMsg,
      details: { missingInMatrix, outdatedInMatrix }
    };
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Get matrix configuration for a specific question ID
 */
async function getMatrixByQuestionId(masterId, questionId) {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    const query = `SELECT * FROM public."matrix_user" WHERE fk_question_id = $1 AND deleted_at IS NULL`;
    const res = await client.query(query, [questionId]);
    return res.rows[0] || null;
  } finally {
    await client.end().catch(() => { });
  }
}

/**
 * Unified save for question and matrix configuration
 */
async function saveUnifiedQuestionMatrix(masterId, questionData, matrixData, isEdit, questionId) {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    await client.query('BEGIN');

    // Generate version
    questionData.version = await getNextVersion(client, 'terms_and_conditions_questions');

    let savedQuestion;

    if (isEdit && questionId) {
      // Update question
      const updateData = { ...questionData };
      delete updateData.id;
      const keys = Object.keys(updateData).filter(k => updateData[k] !== undefined);
      const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const values = keys.map(k => updateData[k]);
      values.push(questionId);

      const query = `UPDATE public."terms_and_conditions_questions" SET ${setClause} WHERE id = $${values.length} RETURNING *`;
      const res = await client.query(query, values);
      savedQuestion = res.rows[0];
      await recordHistory(client, 'terms_and_conditions_questions', savedQuestion, 'UPDATE');
    } else {
      // Insert question
      const keys = Object.keys(questionData).filter(k => questionData[k] !== undefined);
      const columns = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = keys.map(k => questionData[k]);

      const query = `INSERT INTO public."terms_and_conditions_questions" (${columns}) VALUES (${placeholders}) RETURNING *`;
      const res = await client.query(query, values);
      savedQuestion = res.rows[0];
      await recordHistory(client, 'terms_and_conditions_questions', savedQuestion, 'CREATE');
    }

    const finalQuestionId = savedQuestion.id;
    matrixData.fk_question_id = finalQuestionId;

    // Handle Matrix Upsert
    const existingMatrixRes = await client.query(`SELECT id FROM public."matrix_user" WHERE fk_question_id = $1`, [finalQuestionId]);
    let savedMatrix;

    if (existingMatrixRes.rowCount > 0) {
      // Update Matrix
      const matrixId = existingMatrixRes.rows[0].id;
      const updateData = { ...matrixData };
      delete updateData.id;
      const keys = Object.keys(updateData).filter(k => updateData[k] !== undefined);
      const setClause = keys.map((k, i) => `"${k}" = $${i + 1}`).join(', ');
      const values = keys.map(k => updateData[k]);
      values.push(matrixId);

      const query = `UPDATE public."matrix_user" SET ${setClause} WHERE id = $${values.length} RETURNING *`;
      const res = await client.query(query, values);
      savedMatrix = res.rows[0];
      await recordHistory(client, 'matrix_user', savedMatrix, 'UPDATE');
    } else {
      // Insert Matrix
      // Generate ID if missing because schema requires it usually (or defaults to uuid_generate_v4())
      // Wait, let's let postgres default it if it's default uuid. Usually it's handled.
      // But matrix_user history expects `id` to be defined. So we must ensure it is returned.
      const keys = Object.keys(matrixData).filter(k => matrixData[k] !== undefined);
      const columns = keys.map(k => `"${k}"`).join(', ');
      const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
      const values = keys.map(k => matrixData[k]);

      const query = `INSERT INTO public."matrix_user" (${columns}) VALUES (${placeholders}) RETURNING *`;
      const res = await client.query(query, values);
      savedMatrix = res.rows[0];
      await recordHistory(client, 'matrix_user', savedMatrix, 'CREATE');
    }

    await client.query('COMMIT');
    return { question: savedQuestion, matrix: savedMatrix };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end().catch(() => { });
  }
}

module.exports = {
  getMasterTableData,
  createMasterRow,
  updateMasterRow,
  deleteMasterRow,
  validateMatrixQuestions,
  getMatrixByQuestionId,
  saveUnifiedQuestionMatrix
};
