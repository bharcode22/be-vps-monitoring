const { Client } = require('pg');
const { executeSshCommand } = require('../../../utils/sshExecutor');

const POD_DB_USER = process.env.POD_DB_USER || 'development';
const POD_DB_PASS = process.env.POD_DB_PASS || 'development';
const POD_DB_NAME = process.env.POD_DB_NAME || 'regenesis';
const POD_DB_PORT = parseInt(process.env.POD_DB_PORT || '5432', 10);

function getPodDbUrl(host) {
  const encUser = encodeURIComponent(POD_DB_USER);
  const encPass = encodeURIComponent(POD_DB_PASS);
  return `postgresql://${encUser}:${encPass}@${host}:${POD_DB_PORT}/${POD_DB_NAME}?schema=public`;
}

/**
 * Execute query on POD PostgreSQL with direct PG and SSH fallback
 */
async function queryPodDb(podServer, queryStr, params = []) {
  const host = podServer.host;

  // 1. Direct PG
  try {
    const client = new Client({
      connectionString: getPodDbUrl(host),
      connectionTimeoutMillis: 3500,
      statement_timeout: 6000
    });
    await client.connect();
    const res = await client.query(queryStr, params);
    await client.end();
    return res.rows || [];
  } catch (directErr) {
    console.warn(`[Report Collector] Direct PG query failed on ${podServer.name}: ${directErr.message}. Mencoba SSH fallback...`);
  }

  // 2. SSH Fallback
  try {
    let formattedQuery = queryStr;
    if (params && params.length > 0) {
      params.forEach((param, idx) => {
        const placeholder = `$${idx + 1}`;
        const safeVal = typeof param === 'number' ? param : `'${String(param).replace(/'/g, "''")}'`;
        formattedQuery = formattedQuery.replace(new RegExp(`\\${placeholder}\\b`, 'g'), safeVal);
      });
    }

    const fetchCmd = `
      export PGPASSWORD='${POD_DB_PASS}'
      run_q() {
        local q="$1"
        local out=""
        out=$(psql -U ${POD_DB_USER} -h 127.0.0.1 -d ${POD_DB_NAME} -t -A -c "$q" 2>/dev/null)
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          out=$(psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "$q" 2>/dev/null)
        fi
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          out=$(docker exec -i postgres-db psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "$q" 2>/dev/null)
        fi
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          local cid=$(docker ps -qf "name=postgres" 2>/dev/null | head -n1)
          if [ -n "$cid" ]; then
            out=$(docker exec -i "$cid" psql -U ${POD_DB_USER} -d ${POD_DB_NAME} -t -A -c "$q" 2>/dev/null)
          fi
        fi
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          out=$(sudo -u postgres psql -d ${POD_DB_NAME} -t -A -c "$q" 2>/dev/null)
        fi
        echo "$out"
      }
      JSON_OUT=$(run_q "SELECT COALESCE(json_agg(t), '[]'::json) FROM (${formattedQuery}) t;")
      echo "===JSON_START==="
      echo "\${JSON_OUT:-[]}"
      echo "===JSON_END==="
    `;

    const sshRes = await executeSshCommand(podServer, fetchCmd, { timeoutMs: 12000 });
    const stdout = typeof sshRes === 'string' ? sshRes : (sshRes && sshRes.stdout ? sshRes.stdout : '');

    if (stdout.includes('===JSON_START===')) {
      const jsonStr = stdout.split('===JSON_START===')[1].split('===JSON_END===')[0].trim();
      const parsed = JSON.parse(jsonStr);
      return Array.isArray(parsed) ? parsed : [];
    }
    return [];
  } catch (sshErr) {
    console.error(`[Report Collector] SSH fallback query error on ${podServer.name}:`, sshErr.message);
    return [];
  }
}

module.exports = {
  getPodDbUrl,
  queryPodDb
};
