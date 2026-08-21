const db = require('./db');
const { getLocalMetrics } = require('./monitor/localCollector');
const { getRemoteSSHMetrics } = require('./monitor/sshCollector');
const { getPostgresMetrics } = require('./monitor/dbCollector');
const { getS3Metrics } = require('./monitor/s3Collector');

// In-memory cache for live real-time metrics and rolling in-memory history (Zero DB write I/O)
const liveMetricsCache = {};
const liveMetricsHistoryCache = {};
const MAX_IN_MEMORY_HISTORY = 60; // Keep last 60 live snapshots in RAM for quick chart rendering

// Locking flag to prevent overlapping metric collection cycles
let isCollectingInProgress = false;

/**
 * Get latest in-memory metric snapshot for a server
 */
function getLatestCachedMetrics(serverId, type = null) {
  if (type) {
    const key = `${type}_${serverId}`;
    if (liveMetricsCache[key]) return liveMetricsCache[key];
  }
  return liveMetricsCache[serverId] || null;
}

/**
 * Get all cached metrics formatted as a list for instant client hydration
 */
function getAllCachedMetricsList() {
  const list = [];
  for (const [key, metrics] of Object.entries(liveMetricsCache)) {
    if (key.includes('_')) {
      const [type, id] = key.split('_');
      list.push({ id: isNaN(id) ? id : Number(id), type, currentMetrics: metrics });
    }
  }
  return list;
}

/**
 * Get in-memory sliding window history for chart rendering
 */
function getMetricsHistory(serverId) {
  return liveMetricsHistoryCache[serverId] || [];
}

/**
 * Poll all servers in database in parallel, store live metrics in RAM, and broadcast via Socket.io
 */
async function collectAllServerMetrics(io) {
  if (isCollectingInProgress) {
    return [];
  }
  isCollectingInProgress = true;

  try {
    const sshServers = await db.all('SELECT * FROM servers');
    const dbServers = (await db.all('SELECT * FROM databases_postgres')).map(r => ({ ...r, type: 'postgresql', username: r.db_user }));
    const storageServers = (await db.all('SELECT * FROM object_storages')).map(r => ({ ...r, host: r.s3_endpoint || 's3.amazonaws.com', username: r.s3_access_key }));

    const servers = [...sshServers, ...dbServers, ...storageServers];
    const now = new Date().toISOString();

    // Fast parallel collection across all registered servers
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

      const serverType = server.type || 'vps';
      const cacheKey = `${serverType}_${server.id}`;

      // Update in-memory real-time cache (both compound key and legacy id)
      const snapshot = { ...metrics, timestamp: now };
      liveMetricsCache[cacheKey] = snapshot;
      liveMetricsCache[server.id] = snapshot;

      // Update in-memory sliding history window
      if (!liveMetricsHistoryCache[server.id]) {
        liveMetricsHistoryCache[server.id] = [];
      }
      liveMetricsHistoryCache[server.id].push({
        cpu_usage: metrics.cpuUsage || 0,
        ram_usage: metrics.ramUsage || 0,
        ram_used_mb: metrics.ramUsedMb || 0,
        ram_total_mb: metrics.ramTotalMb || 0,
        bandwidth_rx_speed: metrics.bandwidthRxSpeed || 0,
        bandwidth_tx_speed: metrics.bandwidthTxSpeed || 0,
        disk_usage: metrics.diskUsage || 0,
        gpu_usage: metrics.gpuUsage || 0,
        gpu_memory_usage: metrics.gpuMemoryUsage || 0,
        gpu_temp: metrics.gpuTemp || 0,
        ping_ms: metrics.pingMs || 0,
        timestamp: now
      });

      if (liveMetricsHistoryCache[server.id].length > MAX_IN_MEMORY_HISTORY) {
        liveMetricsHistoryCache[server.id].shift();
      }

      return {
        id: server.id,
        type: serverType,
        currentMetrics: metrics
      };
    }));

    // Broadcast lightweight payload to Socket.io subscribers in real-time
    if (io) {
      io.emit('metrics_update', results);
    }

    return results;
  } catch (err) {
    console.error('Error in collectAllServerMetrics:', err.message);
    return [];
  } finally {
    isCollectingInProgress = false;
  }
}

module.exports = {
  getLocalMetrics,
  getRemoteSSHMetrics,
  collectAllServerMetrics,
  getLatestCachedMetrics,
  getAllCachedMetricsList,
  getMetricsHistory
};
