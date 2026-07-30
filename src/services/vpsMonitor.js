const db = require('./db');
const { getLocalMetrics } = require('./monitor/localCollector');
const { getRemoteSSHMetrics } = require('./monitor/sshCollector');

// In-memory cache tracking the last SQLite DB insert timestamp per server
const lastDbSaveTimes = {};
const DB_SAVE_INTERVAL_MS = 15000; // Save history snapshot every 15 seconds (reduces DB write I/O by 80%)

/**
 * Poll all servers in database, record metrics into SQLite, and broadcast via Socket.io
 */
async function collectAllServerMetrics(io) {
  const servers = await db.all('SELECT * FROM servers');
  const results = [];
  const now = Date.now();

  for (const server of servers) {
    let metrics;
    if (server.is_local === 1) {
      metrics = await getLocalMetrics();
    } else {
      metrics = await getRemoteSSHMetrics(server);
    }

    // Save to database metrics_history table with throttling (every 15s) to save Disk I/O
    const shouldSaveToDb = !lastDbSaveTimes[server.id] || (now - lastDbSaveTimes[server.id] >= DB_SAVE_INTERVAL_MS);
    if (shouldSaveToDb) {
      lastDbSaveTimes[server.id] = now;
      await db.run(
        `INSERT INTO metrics_history (
          server_id, cpu_usage, cpu_cores, ram_usage, ram_used_mb, ram_free_mb, ram_total_mb,
          bandwidth_rx_speed, bandwidth_tx_speed, disk_usage, disk_used_gb, disk_total_gb, disk_free_gb,
          gpu_usage, gpu_memory_usage, gpu_name, gpu_temp, ping_ms, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          server.id,
          metrics.cpuUsage,
          metrics.cpuCores,
          metrics.ramUsage,
          metrics.ramUsedMb,
          metrics.ramFreeMb,
          metrics.ramTotalMb,
          metrics.bandwidthRxSpeed,
          metrics.bandwidthTxSpeed,
          metrics.diskUsage,
          metrics.diskUsedGb,
          metrics.diskTotalGb,
          metrics.diskFreeGb,
          metrics.gpuUsage,
          metrics.gpuMemoryUsage,
          metrics.gpuName,
          metrics.gpuTemp,
          metrics.pingMs,
          metrics.status
        ]
      );
    }

    results.push({
      ...server,
      // Hide raw passwords when sending to frontend
      password: server.password ? '******' : '',
      private_key: server.private_key ? '******' : '',
      currentMetrics: metrics
    });
  }

  // Cleanup history older than 24 hours to keep DB lightweight
  await db.run(`DELETE FROM metrics_history WHERE timestamp < datetime('now', '-24 hours')`);

  // Broadcast to Socket.io subscribers
  if (io) {
    io.emit('metrics_update', results);
  }

  return results;
}

module.exports = {
  getLocalMetrics,
  getRemoteSSHMetrics,
  collectAllServerMetrics
};
