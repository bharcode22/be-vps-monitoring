const { pool } = require('./db');

// In-memory registry of latest heartbeat status per pod & module
// Map<podId, Map<moduleId, { hb, lastSeenAt, isAlive, previousHb, lastHbChangeAt }>>
const heartbeatRegistry = new Map();

// Alert history log ring buffer
const recentAlerts = [];
const MAX_ALERTS = 100;

let socketIoInstance = null;
let watchdogInterval = null;

const TIMEOUT_DEAD_SECONDS = 12; // Modul dianggap mati jika tidak kirim hb > 12 detik
const TIMEOUT_WARNING_SECONDS = 5; // Modul dianggap delay jika > 5 detik

/**
 * Initialize Postgres schema for heartbeat incident logs
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
        alert_type VARCHAR(30) NOT NULL, -- 'DEAD', 'DELAY', 'FROZEN', 'RECOVERED'
        message TEXT,
        last_hb BIGINT,
        duration_seconds INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_hb_alerts_server_id ON pod_heartbeat_alerts(server_id);
      CREATE INDEX IF NOT EXISTS idx_hb_alerts_created_at ON pod_heartbeat_alerts(created_at DESC);
    `);
  } catch (err) {
    console.warn('⚠️ Could not initialize pod_heartbeat_alerts schema:', err.message);
  }
}

/**
 * Update incoming packet in registry
 */
function recordHeartbeatPacket({ serverId, serverName, moduleId, hb, timestamp = Date.now() }) {
  if (!serverId || !moduleId) return;

  if (!heartbeatRegistry.has(serverId)) {
    heartbeatRegistry.set(serverId, new Map());
  }

  const podModules = heartbeatRegistry.get(serverId);
  const now = Date.now();
  const prevRecord = podModules.get(moduleId);

  let isFrozen = false;
  let lastHbChangeAt = now;

  if (prevRecord) {
    if (prevRecord.hb === hb) {
      lastHbChangeAt = prevRecord.lastHbChangeAt || now;
      if (now - lastHbChangeAt > 15000) {
        isFrozen = true;
      }
    }
  }

  const record = {
    serverId,
    serverName: serverName || `Pod ${serverId}`,
    moduleId: Number(moduleId),
    hb: Number(hb),
    lastSeenAt: now,
    previousHb: prevRecord?.hb ?? null,
    lastHbChangeAt,
    isFrozen,
    isDead: false,
    alertSent: false
  };

  podModules.set(moduleId, record);
}

/**
 * Record incident alert into DB and ring buffer
 */
async function logIncidentAlert(alert) {
  const entry = {
    id: `alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...alert,
    createdAt: new Date().toISOString()
  };

  recentAlerts.unshift(entry);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();

  // Save to DB asynchronously
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

  // Broadcast via Socket.io
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
  initAlertsSchema();

  if (watchdogInterval) clearInterval(watchdogInterval);
  watchdogInterval = setInterval(runWatchdogCheck, 4000);
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
  getRecentIncidentAlerts,
  logIncidentAlert
};
