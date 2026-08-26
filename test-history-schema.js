const { Client } = require('pg');
const { dbAsync } = require('./src/services/db');
const { decrypt } = require('./src/utils/crypto');

async function run() {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = 5');
  const client = new Client({
    host: master.host,
    port: master.port,
    user: master.db_user,
    password: decrypt(master.password),
    database: master.db_name,
    ssl: { rejectUnauthorized: false }
  });
  await client.connect();
  
  const tables = [
    'terms_and_conditions', 'terms_and_conditions_version',
    'terms_and_conditions_questions', 'terms_and_conditions_question_history',
    'matrix_user', 'matrix_user_history'
  ];

  for (const table of tables) {
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1
    `, [table]);
    console.log(`\n=== Table: ${table} ===`);
    console.log(res.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
  }

  await client.end();
  process.exit(0);
}
run().catch(console.error);
