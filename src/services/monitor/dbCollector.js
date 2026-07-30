const { Client } = require('pg');

/**
 * Gather real-time metrics for PostgreSQL database
 */
async function getPostgresMetrics(server) {
  const startTime = Date.now();
  const pgClient = new Client({
    host: server.host,
    port: server.port || 5432,
    database: server.db_name || 'postgres',
    user: server.db_user || server.username || 'postgres',
    password: server.password || '',
    connectionTimeoutMillis: 5000
  });

  try {
    await pgClient.connect();
    const pingMs = Math.round(Date.now() - startTime);

    // 1. Active connections
    const connRes = await pgClient.query("SELECT count(*) FROM pg_stat_activity WHERE state = 'active'");
    const activeConnections = parseInt(connRes.rows[0]?.count || 0, 10);

    // 2. Total connections (all states)
    const totalConnRes = await pgClient.query("SELECT count(*) FROM pg_stat_activity");
    const totalConnections = parseInt(totalConnRes.rows[0]?.count || 0, 10);

    // 3. Database size in MB & GB
    const dbName = server.db_name || 'postgres';
    const sizeRes = await pgClient.query("SELECT pg_database_size($1) as size_bytes", [dbName]);
    const sizeBytes = parseInt(sizeRes.rows[0]?.size_bytes || 0, 10);
    const ramUsedMb = Math.round((sizeBytes / (1024 * 1024)) * 100) / 100;
    const diskUsedGb = Math.round((sizeBytes / (1024 * 1024 * 1024)) * 100) / 100;

    // 4. Total transactions (commit + rollback)
    const tpsRes = await pgClient.query("SELECT sum(xact_commit + xact_rollback) as total_xact FROM pg_stat_database WHERE datname = $1", [dbName]);
    const totalTransactions = parseInt(tpsRes.rows[0]?.total_xact || 0, 10);

    // 5. Active Queries list (Top 10)
    const queriesRes = await pgClient.query(`
      SELECT pid, usename, client_addr, state, query_start, query 
      FROM pg_stat_activity 
      WHERE state != 'idle' AND query NOT LIKE '%pg_stat_activity%' 
      ORDER BY query_start ASC LIMIT 10
    `);

    const activeQueries = queriesRes.rows.map(q => ({
      pid: q.pid,
      user: q.usename,
      client_addr: q.client_addr || 'local',
      state: q.state,
      duration: q.query_start ? Math.round((Date.now() - new Date(q.query_start).getTime()) / 1000) : 0,
      query: q.query
    }));

    await pgClient.end();

    return {
      cpuUsage: Math.min(100, Math.round((activeConnections / 20) * 100)),
      cpuCores: totalConnections,
      ramUsage: activeConnections,
      ramUsedMb,
      ramFreeMb: 0,
      ramTotalMb: ramUsedMb,
      bandwidthRxSpeed: totalTransactions % 1000,
      bandwidthTxSpeed: activeQueries.length,
      diskUsage: Math.min(100, Math.round((diskUsedGb / 100) * 100)),
      diskUsedGb,
      diskTotalGb: 100,
      diskFreeGb: 100 - diskUsedGb,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: `PostgreSQL (${dbName})`,
      gpuTemp: 0,
      pingMs,
      status: 'online',
      activeQueries,
      activeConnections,
      totalConnections,
      totalTransactions
    };
  } catch (err) {
    try { await pgClient.end(); } catch (e) {}
    return {
      cpuUsage: 0,
      cpuCores: 1,
      ramUsage: 0,
      ramUsedMb: 0,
      ramFreeMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskFreeGb: 0,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: 'PostgreSQL (Offline)',
      gpuTemp: 0,
      pingMs: 0,
      status: 'offline',
      error: err.message,
      activeQueries: [],
      activeConnections: 0,
      totalConnections: 0,
      totalTransactions: 0
    };
  }
}

module.exports = {
  getPostgresMetrics
};
