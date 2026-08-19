const db = require('./db');
const { getLocalMetrics } = require('./monitor/localCollector');
const { getRemoteSSHMetrics } = require('./monitor/sshCollector');
const { getPostgresMetrics } = require('./monitor/dbCollector');
const { getS3Metrics } = require('./monitor/s3Collector');

// In-memory cache tracking the last SQLite DB insert timestamp per server
const lastDbSaveTimes = {};
const DB_SAVE_INTERVAL_MS = 15000; // Save history snapshot every 15 seconds (reduces DB write I/O by 80%)

/**
 * Poll all servers in database in parallel, record metrics into SQLite, and broadcast via Socket.io
 */
async function collectAllServerMetrics(io) {
  try {
    const sshServers = await db.all('SELECT * FROM servers');
    const dbServers = (await db.all('SELECT * FROM databases_postgres')).map(r => ({ ...r, type: 'postgresql', username: r.db_user }));
    const storageServers = (await db.all('SELECT * FROM object_storages')).map(r => ({ ...r, host: r.s3_endpoint || 's3.amazonaws.com', username: r.s3_access_key }));

    const servers = [...sshServers, ...dbServers, ...storageServers];
    const now = Date.now();

    // Parallel metric collection using Promise.all for maximum efficiency & speed
    const results = await Promise.all(servers.map(async (server) => {
      let metrics;
      try {
        if (server.type === 'postgresql') {
          metrics = await getPostgresMetrics(server);
        } else if (server.type === 'minio' || server.type === 's3') {
          metrics = await getS3Metrics(server);
        } else if (server.is_local === 1) {
          metrics = await getLocalMetrics();
        } else {
          metrics = await getRemoteSSHMetrics(server);
        }
      } catch (err) {
        metrics = {
          cpuUsage: 0, cpuCores: 1, ramUsage: 0, ramUsedMb: 0, ramFreeMb: 0, ramTotalMb: 0,
          bandwidthRxSpeed: 0, bandwidthTxSpeed: 0, diskUsage: 0, diskUsedGb: 0, diskTotalGb: 0, diskFreeGb: 0,
          gpuUsage: 0, gpuMemoryUsage: 0, gpuName: 'N/A', gpuTemp: 0, pingMs: 0, status: 'offline'
        };
      }

      // Save to database metrics_history table with throttling (every 15s) for SSH/POD servers
      const isSshServer = server.type === 'vps' || server.type === 'pod' || server.is_local === 1 || !server.type;
      const shouldSaveToDb = isSshServer && (!lastDbSaveTimes[server.id] || (now - lastDbSaveTimes[server.id] >= DB_SAVE_INTERVAL_MS));
      if (shouldSaveToDb) {
        lastDbSaveTimes[server.id] = now;
        db.run(
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
        ).catch(e => console.error('Error inserting metrics history:', e.message));
      }

      return {
        id: server.id,
        type: server.type || 'vps',
        currentMetrics: metrics
      };
    }));

    // Cleanup history older than 24 hours to keep DB lightweight
    await db.run(`DELETE FROM metrics_history WHERE timestamp < NOW() - INTERVAL '24 hours'`).catch(() => {});

    // Broadcast lightweight payload to Socket.io subscribers
    if (io) {
      io.emit('metrics_update', results);
    }

    return results;
  } catch (err) {
    console.error('Error in collectAllServerMetrics:', err.message);
    return [];
  }
}

module.exports = {
  getLocalMetrics,
  getRemoteSSHMetrics,
  collectAllServerMetrics
};
