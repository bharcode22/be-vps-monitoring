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

    const columns = schemaRes.rows.map(r => ({
      name: r.column_name,
      type: r.data_type,
      default: r.column_default,
      nullable: r.is_nullable === 'YES',
      isPk: r.column_name === pkColumn
    }));

    // 3. Get Data (limit to 1000 to prevent overloading browser)
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
    await client.end().catch(() => {});
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
    const keys = Object.keys(data).filter(k => data[k] !== undefined && data[k] !== '');
    if (keys.length === 0) throw new Error('Tidak ada data yang dikirim.');

    const columns = keys.map(k => `"${k}"`).join(', ');
    const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
    const values = keys.map(k => data[k]);

    const query = `INSERT INTO public."${tableName}" (${columns}) VALUES (${placeholders}) RETURNING *`;
    const res = await client.query(query, values);
    
    return res.rows[0];
  } finally {
    await client.end().catch(() => {});
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

    return res.rows[0];
  } finally {
    await client.end().catch(() => {});
  }
}

module.exports = {
  getMasterTableData,
  createMasterRow,
  updateMasterRow
};
