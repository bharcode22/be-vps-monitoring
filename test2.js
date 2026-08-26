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
  const res1 = await masterClient.query('SELECT COUNT(*) FROM terms_and_conditions_answers');
  console.log('Master Row Count:', res1.rows[0].count);
  await masterClient.end();

  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = 8');
  const podClient = new Client({
    host: pod.host,
    port: pod.port,
    user: pod.username,
    password: decrypt(pod.password),
    database: 'postgres'
  });
  await podClient.connect();
  const res2 = await podClient.query('SELECT COUNT(*) FROM terms_and_conditions_answers');
  console.log('POD RIG 30 Row Count:', res2.rows[0].count);
  await podClient.end();
  process.exit(0);
}

run().catch(console.error);
