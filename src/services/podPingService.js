const net = require('net');
const { execFile } = require('child_process');
const { dbAsync } = require('./db');

const DEFAULT_PING_INTERVAL_MS = 5000;
const MAX_HISTORY_POINTS = 60; // 60 titik pengukuran (5 menit riwayat dengan interval 5s)
const TCP_TIMEOUT_MS = 3000;

// In-memory latency cache: Map<podId, { history: Array<{ ts, pingMs, success }>, stats: Object }>
const podLatencyMap = new Map();
let isWorkerRunning = false;
let workerTimer = null;
let socketIoInstance = null;

/**
 * Measure TCP connection latency to target host and port
 * @param {string} host Target IP or hostname
 * @param {number} port Target port (default 1883 for MQTT broker)
 * @param {number} timeoutMs Connect timeout in milliseconds
 * @returns {Promise<{ success: boolean, pingMs: number|null, port: number, error?: string }>}
 */
function measureTcpLatency(host, port = 1883, timeoutMs = TCP_TIMEOUT_MS) {
  return new Promise((resolve) => {
    if (!host) {
      return resolve({ success: false, pingMs: null, port, error: 'NO_HOST' });
    }

    const startNs = process.hrtime.bigint();
    let isSettled = false;

    const socket = new net.Socket();

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      if (isSettled) return;
      isSettled = true;
      const endNs = process.hrtime.bigint();
      const rttMs = Number(endNs - startNs) / 1e6;
      cleanup();
      resolve({
        success: true,
        pingMs: Math.round(rttMs * 10) / 10,
        port
      });
    });

    socket.on('timeout', () => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve({
        success: false,
        pingMs: null,
        port,
        error: 'TIMEOUT'
      });
    });

    socket.on('error', (err) => {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      // Note: If connection was actively refused (ECONNREFUSED), host is still reachable on network
      const isRefused = err.code === 'ECONNREFUSED';
      if (isRefused) {
        const endNs = process.hrtime.bigint();
        const rttMs = Number(endNs - startNs) / 1e6;
        return resolve({
          success: true,
          pingMs: Math.round(rttMs * 10) / 10,
          port,
          note: 'PORT_CLOSED_HOST_ALIVE'
        });
      }
      resolve({
        success: false,
        pingMs: null,
        port,
        error: err.code || err.message || 'SOCKET_ERROR'
      });
    });

    try {
      socket.connect(port, host);
    } catch (err) {
      if (isSettled) return;
      isSettled = true;
      cleanup();
      resolve({
        success: false,
        pingMs: null,
        port,
        error: err.message || 'CONNECT_FAILED'
      });
    }
  });
}

/**
 * Fallback ICMP ping using system binary
 * @param {string} host
 * @param {number} timeoutSec
 */
function measureIcmpLatency(host, timeoutSec = 2) {
  return new Promise((resolve) => {
    if (!host) return resolve({ success: false, pingMs: null, error: 'NO_HOST' });
    const isWin = process.platform === 'win32';
    const cmd = isWin ? 'ping' : 'ping';
    const args = isWin ? ['-n', '1', '-w', String(timeoutSec * 1000), host] : ['-c', '1', '-W', String(timeoutSec), host];

    execFile(cmd, args, { timeout: (timeoutSec + 1) * 1000 }, (err, stdout) => {
      if (err || !stdout) {
        return resolve({ success: false, pingMs: null, error: err?.message || 'PING_FAILED' });
      }
      // Parse output for time=XX ms
      const match = stdout.match(/time[=<](\d+(?:\.\d+)?)\s*ms/i);
      if (match) {
        return resolve({ success: true, pingMs: parseFloat(match[1]) });
      }
      resolve({ success: false, pingMs: null, error: 'PARSE_FAILED' });
    });
  });
}

/**
 * Single probe to a POD (tries MQTT 1883 first, SSH 22 fallback)
 */
async function probePod(pod) {
  const host = pod.host;
  // 1. Probe primary MQTT port 1883
  let res = await measureTcpLatency(host, 1883, TCP_TIMEOUT_MS);

  // 2. If timed out or unreachable, try SSH port 22 fallback
  if (!res.success && (pod.port || 22)) {
    const fallbackPort = Number(pod.port) || 22;
    const sshRes = await measureTcpLatency(host, fallbackPort, 2000);
    if (sshRes.success) {
      res = sshRes;
    }
  }

  return res;
}

/**
 * Update latency record for a pod and recalculate metrics
 */
function updatePodLatencyRecord(podId, podMeta, probeResult) {
  const id = Number(podId);
  const now = Date.now();

  if (!podLatencyMap.has(id)) {
    podLatencyMap.set(id, {
      podId: id,
      podCode: podMeta.code || String(id),
      podName: podMeta.name || `POD ${id}`,
      host: podMeta.host,
      history: [],
      stats: {
        currentPingMs: null,
        avgPingMs: null,
        minPingMs: null,
        maxPingMs: null,
        jitterMs: null,
        packetLossPct: 0,
        quality: 'UNKNOWN',
        lastUpdated: now,
        isOnline: false
      }
    });
  }

  const record = podLatencyMap.get(id);
  record.podCode = podMeta.code || record.podCode;
  record.podName = podMeta.name || record.podName;
  record.host = podMeta.host || record.host;

  // Append new data point
  record.history.push({
    ts: now,
    pingMs: probeResult.success ? probeResult.pingMs : null,
    success: probeResult.success,
    error: probeResult.error || null,
    port: probeResult.port || null
  });

  if (record.history.length > MAX_HISTORY_POINTS) {
    record.history.shift();
  }

  // Calculate sliding stats
  const validPings = record.history.filter(h => h.success && h.pingMs !== null).map(h => h.pingMs);
  const totalCount = record.history.length;
  const failCount = record.history.filter(h => !h.success).length;

  const packetLossPct = totalCount > 0 ? Math.round((failCount / totalCount) * 100) : 0;
  const currentPingMs = probeResult.success ? probeResult.pingMs : null;

  let avgPingMs = null;
  let minPingMs = null;
  let maxPingMs = null;
  let jitterMs = null;

  if (validPings.length > 0) {
    minPingMs = Math.min(...validPings);
    maxPingMs = Math.max(...validPings);
    avgPingMs = Math.round((validPings.reduce((a, b) => a + b, 0) / validPings.length) * 10) / 10;

    // Calculate jitter as mean absolute difference between consecutive pings
    if (validPings.length > 1) {
      let diffSum = 0;
      for (let i = 1; i < validPings.length; i++) {
        diffSum += Math.abs(validPings[i] - validPings[i - 1]);
      }
      jitterMs = Math.round((diffSum / (validPings.length - 1)) * 10) / 10;
    } else {
      jitterMs = 0;
    }
  }

  // Determine network quality rating
  let quality = 'UNKNOWN';
  if (!probeResult.success && packetLossPct >= 80) {
    quality = 'OFFLINE';
  } else if (currentPingMs !== null) {
    if (currentPingMs < 25 && packetLossPct === 0) quality = 'EXCELLENT';
    else if (currentPingMs < 80 && packetLossPct <= 10) quality = 'GOOD';
    else if (currentPingMs < 200 || packetLossPct <= 30) quality = 'DEGRADED';
    else quality = 'POOR';
  } else {
    quality = 'UNREACHABLE';
  }

  record.stats = {
    currentPingMs,
    avgPingMs,
    minPingMs,
    maxPingMs,
    jitterMs,
    packetLossPct,
    quality,
    lastUpdated: now,
    isOnline: probeResult.success,
    error: probeResult.error || null,
    port: probeResult.port || null
  };

  return record;
}

/**
 * Execute a single ping round across all POD v3 units
 */
async function executePodV3PingRound() {
  try {
    // Explicitly query ONLY POD v3 servers
    const v3Pods = await dbAsync.all(
      `SELECT id, name, code, host, port, type, pod_version
       FROM servers
       WHERE type = 'pod' AND LOWER(TRIM(COALESCE(pod_version, ''))) = 'v3'
       ORDER BY name ASC`
    );

    if (!Array.isArray(v3Pods) || v3Pods.length === 0) {
      return [];
    }

    const probePromises = v3Pods.map(async (pod) => {
      const probeRes = await probePod(pod);
      const record = updatePodLatencyRecord(pod.id, pod, probeRes);
      return {
        podId: pod.id,
        podCode: pod.code,
        podName: pod.name,
        host: pod.host,
        ...record.stats
      };
    });

    const results = await Promise.all(probePromises);

    // Broadcast update to frontend via WebSocket
    if (socketIoInstance) {
      socketIoInstance.emit('pod_latency_update', {
        timestamp: Date.now(),
        fleetLatency: results
      });
    }

    return results;
  } catch (err) {
    console.warn('⚠️ Error in executePodV3PingRound:', err.message);
    return [];
  }
}

/**
 * Start recurring background worker for POD v3 latency polling
 */
function startPodV3PingWorker(io = null, intervalMs = DEFAULT_PING_INTERVAL_MS) {
  if (io) {
    socketIoInstance = io;
  }

  if (isWorkerRunning) return;
  isWorkerRunning = true;

  console.log(`📡 Pod v3 Ping & Latency Worker started (interval: ${intervalMs}ms)`);

  const loop = async () => {
    if (!isWorkerRunning) return;
    await executePodV3PingRound();
    workerTimer = setTimeout(loop, intervalMs);
  };

  // Run first check after a brief 1.5s warmup delay
  setTimeout(loop, 1500);
}

/**
 * Stop background worker
 */
function stopPodV3PingWorker() {
  isWorkerRunning = false;
  if (workerTimer) {
    clearTimeout(workerTimer);
    workerTimer = null;
  }
}

/**
 * Get snapshot for a specific POD (by ID or Code)
 */
function getPodLatencySnapshot(podId) {
  const pId = Number(podId);
  if (podLatencyMap.has(pId)) {
    return podLatencyMap.get(pId);
  }
  // Try matching by podCode
  for (const record of podLatencyMap.values()) {
    if (String(record.podCode) === String(podId) || String(record.podId) === String(podId)) {
      return record;
    }
  }
  return null;
}

/**
 * Get all POD v3 latency snapshots for fleet dashboard
 */
function getAllPodV3LatencySnapshot() {
  const list = [];
  for (const record of podLatencyMap.values()) {
    list.push({
      podId: record.podId,
      podCode: record.podCode,
      podName: record.podName,
      host: record.host,
      ...record.stats
    });
  }
  return list;
}

/**
 * Trigger immediate on-demand ping for a specific pod
 */
async function pingPodOnDemand(podId) {
  const pId = Number(podId);
  const pod = await dbAsync.get(
    `SELECT id, name, code, host, port, type, pod_version
     FROM servers
     WHERE (id = ? OR code = ?) AND type = 'pod' AND LOWER(TRIM(COALESCE(pod_version, ''))) = 'v3'
     LIMIT 1`,
    [pId, String(podId)]
  );

  if (!pod) {
    throw new Error(`POD v3 dengan ID/Kode '${podId}' tidak ditemukan.`);
  }

  const probeRes = await probePod(pod);
  const record = updatePodLatencyRecord(pod.id, pod, probeRes);

  if (socketIoInstance) {
    socketIoInstance.emit('pod_latency_single', {
      podId: pod.id,
      podCode: pod.code,
      podName: pod.name,
      ...record.stats
    });
  }

  return {
    podId: pod.id,
    podCode: pod.code,
    podName: pod.name,
    host: pod.host,
    ...record.stats,
    history: record.history
  };
}

module.exports = {
  startPodV3PingWorker,
  stopPodV3PingWorker,
  measureTcpLatency,
  measureIcmpLatency,
  getPodLatencySnapshot,
  getAllPodV3LatencySnapshot,
  pingPodOnDemand
};
