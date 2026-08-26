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
  const res = await masterClient.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'terms_and_conditions_answers'");
  console.log('Columns in terms_and_conditions_answers:', res.rows.map(r => r.column_name));
  await masterClient.end();
  process.exit(0);
}

run().catch(console.error);
