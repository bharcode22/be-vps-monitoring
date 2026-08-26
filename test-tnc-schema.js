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
    'matrix_user_history', 'user', 'terms_and_conditions_version_question', 
    'terms_and_conditions_version', 'terms_and_conditions_questions', 
    'terms_and_conditions_question_history', 'terms_and_conditions_question_bundle', 
    'terms_and_conditions_answers_history', 'terms_and_conditions_answers', 
    'terms_and_conditions_accepted_history', 'terms_and_conditions_accepted', 
    'terms_and_conditions', 'matrix_user'
  ];

  for (const table of tables) {
    const res = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = $1
    `, [table]);
    
    const countRes = await client.query(`SELECT count(*) FROM public."${table}"`);
    console.log(`\n=== Table: ${table} (${countRes.rows[0].count} rows) ===`);
    console.log(res.rows.map(r => `${r.column_name} (${r.data_type})`).join(', '));
  }

  await client.end();
  process.exit(0);
}
run().catch(console.error);
