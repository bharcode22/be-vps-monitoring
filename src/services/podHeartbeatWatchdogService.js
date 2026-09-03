const { pool } = require('./db');
const {
  initPodStorage,
  recordPodEvent,
  recordRawHeartbeatTick,
  saveFleetSnapshot,
  getFleetSnapshot,
  savePodState
} = require('./podStorageService');

// In-memory registry of latest heartbeat status per pod & module
// Map<podId, Map<moduleId, { hb, lastSeenAt, isAlive, previousHb, lastHbChangeAt, port, totalPackets }>>
const heartbeatRegistry = new Map();

// Alert history log ring buffer
const recentAlerts = [];
const MAX_ALERTS = 100;

let socketIoInstance = null;
let watchdogInterval = null;
let snapshotInterval = null;

const TIMEOUT_DEAD_SECONDS = 30; // Modul dianggap mati jika tidak kirim hb >= 30 detik
const TIMEOUT_WARNING_SECONDS = 3; // Modul dianggap pulih jika delay < 3 detik

/**
 * Initialize Postgres schema for heartbeat incident logs (optional backward compatibility)
 */
async function initAlertsSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pod_heartbeat_alerts (
        id SERIAL PRIMARY KEY,
        server_id INT,
        server_name VARCHAR(100),
        module_id INT NOT NULL,
        module_name VARCHAR(100),
        alert_type VARCHAR(30) NOT NULL,
        message TEXT,
        last_hb BIGINT,
        duration_seconds INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_hb_alerts_server_id ON pod_heartbeat_alerts(server_id);
      CREATE INDEX IF NOT EXISTS idx_hb_alerts_created_at ON pod_heartbeat_alerts(created_at DESC);
    `);
  } catch (err) {
    // Ignore DB errors as JSON file is the primary storage
  }
}

/**
 * Update incoming packet in registry and stream to raw JSONL file
 */
function recordHeartbeatPacket({ serverId, serverName, moduleId, hb, port = null, timestamp = Date.now() }) {
  if (!serverId || !moduleId) return;

  if (!heartbeatRegistry.has(serverId)) {
    heartbeatRegistry.set(serverId, new Map());
  }

  const podModules = heartbeatRegistry.get(serverId);
  const now = timestamp || Date.now();
  const prevRecord = podModules.get(moduleId);

  let isFrozen = false;
  let lastHbChangeAt = now;

  const currentHbNum = (hb !== null && hb !== undefined && !isNaN(Number(hb))) ? Number(hb) : null;
  const prevHbNum = (prevRecord?.hb !== null && prevRecord?.hb !== undefined && !isNaN(Number(prevRecord.hb))) ? Number(prevRecord.hb) : null;

  if (prevRecord) {
    if (prevHbNum !== null && currentHbNum !== null && prevHbNum === currentHbNum) {
      lastHbChangeAt = prevRecord.lastHbChangeAt || now;
      if (now - lastHbChangeAt >= 10000) {
        isFrozen = true;
      }
    } else {
      lastHbChangeAt = now;
    }
  }

  const effectivePort = port || prevRecord?.port || null;

  const record = {
    serverId,
    serverName: serverName || `Pod ${serverId}`,
    moduleId: Number(moduleId),
    hb: currentHbNum,
    lastSeenAt: now,
    previousHb: prevHbNum,
    lastHbChangeAt,
    isFrozen,
    isDead: false,
    port: effectivePort,
    totalPackets: (prevRecord?.totalPackets || 0) + 1,
    alertSent: false
  };

  podModules.set(moduleId, record);

  // Stream raw heartbeat value directly to Pod's daily JSON-Lines file
  recordRawHeartbeatTick({
    podId: serverId,
    serverName,
    moduleId,
    hb: currentHbNum,
    port: effectivePort,
    timestamp: now
  });
}

/**
 * Return in-memory snapshot of all pod heartbeat states
 * Format: { [serverId]: { [moduleId]: { id, hb, lastSeenAt, lastHbChangeAt, isFrozen, port, totalPackets } } }
 */
function getHeartbeatSnapshot() {
  const snapshot = {};
  for (const [serverId, podModules] of heartbeatRegistry.entries()) {
    snapshot[serverId] = {};
    for (const [moduleId, record] of podModules.entries()) {
      snapshot[serverId][moduleId] = {
        id: record.moduleId,
        hb: record.hb,
        lastSeenAt: record.lastSeenAt,
        lastHbChangeAt: record.lastHbChangeAt,
        isFrozen: record.isFrozen,
        isDead: record.isDead,
        port: record.port || null,
        totalPackets: record.totalPackets || 1
      };
    }
  }
  return snapshot;
}

/**
 * Record incident alert into Pod-Centric JSON-Lines log file, DB, and ring buffer
 */
async function logIncidentAlert(alert) {
  const entry = {
    id: `alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...alert,
    createdAt: new Date().toISOString()
  };

  recentAlerts.unshift(entry);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();

  // 1. Record structured event to Pod-Centric JSON-Lines file (Primary storage)
  recordPodEvent({
    podId: alert.serverId,
    podName: alert.serverName,
    moduleId: alert.moduleId,
    moduleName: alert.moduleName,
    eventType: alert.alertType, // 'DEAD', 'FROZEN', 'RECOVERED'
    message: alert.message,
    lastHb: alert.lastHb || 0,
    downtimeSeconds: alert.durationSeconds || 0,
    timestamp: Date.now()
  });

  // 2. Save to DB asynchronously (Secondary backup)
  try {
    await pool.query(`
      INSERT INTO pod_heartbeat_alerts 
        (server_id, server_name, module_id, module_name, alert_type, message, last_hb, duration_seconds)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    `, [
      alert.serverId,
      alert.serverName,
      alert.moduleId,
      alert.moduleName || `Module ${alert.moduleId}`,
      alert.alertType,
      alert.message,
      alert.lastHb || 0,
      alert.durationSeconds || 0
    ]);
  } catch (_) {}

  // 3. Broadcast via Socket.io
  if (socketIoInstance) {
    socketIoInstance.emit('pod-heartbeat:alert', entry);
  }

  return entry;
}

/**
 * Watchdog Periodic Check (Every 4 seconds)
 */
function runWatchdogCheck() {
  const now = Date.now();

  for (const [serverId, podModules] of heartbeatRegistry.entries()) {
    for (const [moduleId, record] of podModules.entries()) {
      const elapsedSec = Math.floor((now - record.lastSeenAt) / 1000);

      // Check for DEAD timeout
      if (elapsedSec >= TIMEOUT_DEAD_SECONDS && !record.isDead) {
        record.isDead = true;
        logIncidentAlert({
          serverId,
          serverName: record.serverName,
          moduleId,
          moduleName: `Module ${moduleId}`,
          alertType: 'DEAD',
          message: `Modul ID ${moduleId} mati / tidak ada heartbeat selama ${elapsedSec} detik!`,
          lastHb: record.hb,
          durationSeconds: elapsedSec
        });
      }
      // Check for RECOVERED
      else if (elapsedSec < TIMEOUT_WARNING_SECONDS && record.isDead) {
        record.isDead = false;
        logIncidentAlert({
          serverId,
          serverName: record.serverName,
          moduleId,
          moduleName: `Module ${moduleId}`,
          alertType: 'RECOVERED',
          message: `Modul ID ${moduleId} pulih kembali (berdetak normal).`,
          lastHb: record.hb,
          durationSeconds: 0
        });
      }
    }
  }
}

/**
 * Start background watchdog engine
 */
function initHeartbeatWatchdog(io) {
  socketIoInstance = io;
  initPodStorage();
  initAlertsSchema();

  // Load previous persisted snapshot from file
  try {
    const savedSnapshot = getFleetSnapshot();
    if (savedSnapshot && typeof savedSnapshot === 'object') {
      for (const [podId, podModules] of Object.entries(savedSnapshot)) {
        if (!heartbeatRegistry.has(Number(podId))) {
          heartbeatRegistry.set(Number(podId), new Map());
        }
        const pMap = heartbeatRegistry.get(Number(podId));
        for (const [modId, modData] of Object.entries(podModules || {})) {
          pMap.set(Number(modId), {
            serverId: Number(podId),
            serverName: `Pod ${podId}`,
            moduleId: Number(modId),
            hb: modData.hb,
            lastSeenAt: modData.lastSeenAt,
            previousHb: null,
            lastHbChangeAt: modData.lastHbChangeAt,
            isFrozen: modData.isFrozen || false,
            isDead: modData.isDead || false,
            port: modData.port || null,
            totalPackets: modData.totalPackets || 1,
            alertSent: false
          });
        }
      }
      console.log('⚡ Loaded previous fleet snapshot into Watchdog Registry.');
    }
  } catch (_) {}

  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(runWatchdogCheck, 4000);

  // Periodically persist snapshot to file every 10 seconds
  if (snapshotInterval) clearInterval(snapshotInterval);
  snapshotInterval = setInterval(() => {
    saveFleetSnapshot(getHeartbeatSnapshot());
  }, 10000);
}

/**
 * Get recent incident alerts
 */
function getRecentIncidentAlerts() {
  return recentAlerts;
}

module.exports = {
  initHeartbeatWatchdog,
  recordHeartbeatPacket,
  getHeartbeatSnapshot,
  getRecentIncidentAlerts,
  logIncidentAlert
};
