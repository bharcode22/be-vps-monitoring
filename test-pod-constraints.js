const { Client } = require('pg');
const { dbAsync } = require('./src/services/db');
const { decrypt } = require('./src/utils/crypto');

async function run() {
  const pod = await dbAsync.get("SELECT * FROM servers WHERE name LIKE '%30%' OR pod_version = 'v3' LIMIT 1");
  console.log('Testing POD:', pod.name, pod.host);
  const podClient = new Client({
    host: pod.host,
    port: pod.port,
    user: pod.username,
    password: decrypt(pod.password),
    database: 'postgres'
  });
  await podClient.connect();

  const ucRes = await podClient.query(`
    SELECT
      tc.table_name, tc.constraint_name, kcu.column_name
    FROM
      information_schema.table_constraints AS tc
      JOIN information_schema.key_column_usage AS kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
    WHERE tc.constraint_type = 'UNIQUE' AND tc.table_name IN ('terms_and_conditions_answers', 'terms_and_conditions_accepted');
  `);
  console.log('POD Unique Constraints:', ucRes.rows);

  await podClient.end();
  process.exit(0);
}

run().catch(console.error);
