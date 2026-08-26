const { Client } = require('pg');
const { dbAsync } = require('./src/services/db');
const { decrypt } = require('./src/utils/crypto');

async function run() {
  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = 5');
  const masterClient = new Client({
    host: master.host,
    port: master.port,
    user: master.db_user,
    password: decrypt(master.password),
    database: master.db_name,
    ssl: { rejectUnauthorized: false }
  });
  await masterClient.connect();
  const res = await masterClient.query(`
    SELECT fk_user_id, fk_question_id, COUNT(*)
    FROM terms_and_conditions_answers
    GROUP BY fk_user_id, fk_question_id
    HAVING COUNT(*) > 1
    LIMIT 5
  `);
  console.log('Duplicates in Master:', res.rows);
  await masterClient.end();
  process.exit(0);
}

run().catch(console.error);
