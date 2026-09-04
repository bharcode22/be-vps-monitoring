const { pool } = require('./db');
const {
  initPodStorage,
  recordPodEvent,
  recordRawHeartbeatTick,
  saveFleetSnapshot,
  getFleetSnapshot,
  savePodState
} = require('./podStorageService');

const {
  getHeartbeatThresholdsConfig,
  getModuleNameById
} = require('./podHeartbeatConfigService');

const {
  sendDeadHeartbeatAlert,
  sendBatchDeadHeartbeatAlert,
  clearDeadAlertCooldown
} = require('./telegramAlertService');

// In-memory registry of latest heartbeat status per pod & module
// Map<podId, Map<moduleId, { hb, lastSeenAt, isAlive, previousHb, lastHbChangeAt, port, totalPackets, deadAlertSent, frozenAlertSent }>>
const heartbeatRegistry = new Map();

// Alert history log ring buffer
const recentAlerts = [];
const MAX_ALERTS = 100;

let socketIoInstance = null;
let watchdogInterval = null;
let snapshotInterval = null;

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
 * Dynamically evaluates FROZEN and RECOVERED states based on configured thresholds
 */
function recordHeartbeatPacket({ serverId, serverName, moduleId, hb, port = null, timestamp = Date.now() }) {
  if (!serverId || !moduleId) return;

  if (!heartbeatRegistry.has(serverId)) {
    heartbeatRegistry.set(serverId, new Map());
  }

  const podModules = heartbeatRegistry.get(serverId);
  const now = timestamp || Date.now();
  const prevRecord = podModules.get(moduleId);
  const thresholds = getHeartbeatThresholdsConfig();
  const moduleName = getModuleNameById(moduleId);

  const currentHbNum = (hb !== null && hb !== undefined && !isNaN(Number(hb))) ? Number(hb) : null;
  const prevHbNum = (prevRecord?.hb !== null && prevRecord?.hb !== undefined && !isNaN(Number(prevRecord.hb))) ? Number(prevRecord.hb) : null;

  let isFrozen = false;
  let lastHbChangeAt = now;

  if (prevRecord) {
    if (prevHbNum !== null && currentHbNum !== null && prevHbNum === currentHbNum) {
      lastHbChangeAt = prevRecord.lastHbChangeAt || now;
      if (now - lastHbChangeAt >= thresholds.frozenSec * 1000) {
        isFrozen = true;
      }
    } else {
      lastHbChangeAt = now;
      isFrozen = false;
    }
  }

  const effectivePort = port || prevRecord?.port || null;
  const sName = serverName || prevRecord?.serverName || `Pod ${serverId}`;

  // Check state transitions for immediate packet-driven alert/recovery
  let deadAlertSent = prevRecord?.deadAlertSent || false;
  let frozenAlertSent = prevRecord?.frozenAlertSent || false;
  const wasDead = prevRecord?.isDead || false;
  const wasFrozen = prevRecord?.isFrozen || false;

  // 1. Module recovered from DEAD
  if (wasDead) {
    deadAlertSent = false;
    clearDeadAlertCooldown(serverId, moduleId);
    logIncidentAlert({
      serverId,
      serverName: sName,
      moduleId,
      moduleName,
      alertType: 'RECOVERED',
      message: `Modul ID ${moduleId} (${moduleName}) pulih kembali (berdetak normal).`,
      lastHb: currentHbNum,
      durationSeconds: prevRecord?.lastSeenAt ? Math.floor((now - prevRecord.lastSeenAt) / 1000) : 0
    });
  }

  // 2. Module recovered from FROZEN (counter resumed incrementing)
  if (wasFrozen && !isFrozen && frozenAlertSent) {
    frozenAlertSent = false;
    logIncidentAlert({
      serverId,
      serverName: sName,
      moduleId,
      moduleName,
      alertType: 'RECOVERED',
      message: `Modul ID ${moduleId} (${moduleName}) kembali berdetak normal (sebelumnya macet di #${prevHbNum}).`,
      lastHb: currentHbNum,
      durationSeconds: 0
    });
  }

  // 3. Module just became FROZEN upon packet arrival
  if (isFrozen && !frozenAlertSent && !wasDead) {
    frozenAlertSent = true;
    const stuckDurationSec = Math.floor((now - lastHbChangeAt) / 1000);
    logIncidentAlert({
      serverId,
      serverName: sName,
      moduleId,
      moduleName,
      alertType: 'FROZEN',
      message: `Modul ID ${moduleId} (${moduleName}) macet / nilai heartbeat tidak bergerak selama ${stuckDurationSec} detik (tetap di #${currentHbNum})!`,
      lastHb: currentHbNum,
      durationSeconds: stuckDurationSec
    });
  }

  const record = {
    serverId,
    serverName: sName,
    moduleId: Number(moduleId),
    moduleName,
    hb: currentHbNum,
    lastSeenAt: now,
    previousHb: prevHbNum,
    lastHbChangeAt,
    isFrozen,
    isDead: false,
    port: effectivePort,
    totalPackets: (prevRecord?.totalPackets || 0) + 1,
    deadAlertSent,
    frozenAlertSent,
    lastAlertAt: prevRecord?.lastAlertAt || 0
  };

  podModules.set(moduleId, record);

  // Stream raw heartbeat value directly to Pod's daily JSON-Lines file
  recordRawHeartbeatTick({
    podId: serverId,
    serverName: sName,
    moduleId,
    hb: currentHbNum,
    port: effectivePort,
    timestamp: now
  });
}

/**
 * Return in-memory snapshot of all pod heartbeat states
 * Format: { [serverId]: { [moduleId]: { id, name, hb, lastSeenAt, lastHbChangeAt, isFrozen, isDead, port, totalPackets } } }
 */
function getHeartbeatSnapshot() {
  const snapshot = {};
  for (const [serverId, podModules] of heartbeatRegistry.entries()) {
    snapshot[serverId] = {};
    for (const [moduleId, record] of podModules.entries()) {
      snapshot[serverId][moduleId] = {
        id: record.moduleId,
        name: record.moduleName,
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
  const moduleFriendlyName = alert.moduleName || getModuleNameById(alert.moduleId);
  const entry = {
    id: `alt_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    ...alert,
    moduleName: moduleFriendlyName,
    createdAt: new Date().toISOString()
  };

  // Anti-Spam Check: Prevent duplicate identical alerts within 3 seconds
  const recentDuplicate = recentAlerts.find(a =>
    a.serverId === alert.serverId &&
    a.moduleId === alert.moduleId &&
    a.alertType === alert.alertType &&
    Math.abs(Date.now() - new Date(a.createdAt).getTime()) < 3000
  );
  if (recentDuplicate) {
    return recentDuplicate;
  }

  recentAlerts.unshift(entry);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.pop();

  // 1. Record structured event to Pod-Centric JSON-Lines file (Primary storage)
  recordPodEvent({
    podId: alert.serverId,
    podName: alert.serverName,
    moduleId: alert.moduleId,
    moduleName: moduleFriendlyName,
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
      moduleFriendlyName,
      alert.alertType,
      alert.message,
      alert.lastHb || 0,
      alert.durationSeconds || 0
    ]);
  } catch (_) { }

  // 3. Broadcast via Socket.io
  if (socketIoInstance) {
    socketIoInstance.emit('pod-heartbeat:alert', entry);
  }

  // 4. Send Telegram Notification strictly when status is DEAD (unless skipTelegram is specified)
  if (alert.alertType === 'DEAD' && !alert.skipTelegram) {
    sendDeadHeartbeatAlert(alert).catch(err => {
      console.warn('[Watchdog] Gagal mengirim alert Telegram:', err.message);
    });
  }

  return entry;
}

/**
 * Watchdog Periodic Check (Every 4 seconds)
 * Evaluates dynamically based on thresholds:
 * - DEAD: elapsedSec >= thresholds.deadSec
 * - FROZEN: hb unchanged >= thresholds.frozenSec
 * - Anti-spam pod aggregation: suppresses 9 separate alerts if whole pod dies simultaneously
 */
function runWatchdogCheck() {
  const now = Date.now();
  const thresholds = getHeartbeatThresholdsConfig();

  for (const [serverId, podModules] of heartbeatRegistry.entries()) {
    let serverName = `Pod ${serverId}`;
    const newlyDeadModules = [];
    const activeModuleCount = podModules.size;

    for (const [moduleId, record] of podModules.entries()) {
      if (record.serverName) serverName = record.serverName;
      const elapsedSec = Math.floor((now - record.lastSeenAt) / 1000);
      const hbElapsedSec = record.lastHbChangeAt ? Math.floor((now - record.lastHbChangeAt) / 1000) : null;
      const modName = record.moduleName || getModuleNameById(moduleId);

      // Check for DEAD timeout
      if (elapsedSec >= thresholds.deadSec && !record.isDead) {
        record.isDead = true;
        record.isFrozen = false;
        record.frozenAlertSent = false;
        newlyDeadModules.push({ moduleId, modName, record, elapsedSec });
      }
      // Check for FROZEN timeout via timer (packets may still be arriving with static hb)
      else if (!record.isDead && !record.frozenAlertSent && hbElapsedSec !== null && hbElapsedSec >= thresholds.frozenSec) {
        record.isFrozen = true;
        record.frozenAlertSent = true;
        logIncidentAlert({
          serverId,
          serverName,
          moduleId,
          moduleName: modName,
          alertType: 'FROZEN',
          message: `Modul ID ${moduleId} (${modName}) macet / nilai heartbeat tidak bergerak selama ${hbElapsedSec} detik (tetap di #${record.hb})!`,
          lastHb: record.hb,
          durationSeconds: hbElapsedSec
        });
      }
    }

    // Process DEAD alerts: Fleet Aggregation vs Batch vs Individual Modules
    if (newlyDeadModules.length > 0) {
      // 1. If 3 or more modules (and >= 70% of pod modules) went DEAD simultaneously, log single aggregated POD alert
      if (newlyDeadModules.length >= 3 && newlyDeadModules.length >= activeModuleCount * 0.7) {
        logIncidentAlert({
          serverId,
          serverName,
          moduleId: 0,
          moduleName: 'All Modules',
          alertType: 'DEAD',
          message: `⚠️ PERINGATAN ARMADA: ${serverName} OFFLINE / Terputus total (${newlyDeadModules.length} modul serentak tidak ada heartbeat)!`,
          lastHb: 0,
          durationSeconds: Math.max(...newlyDeadModules.map(m => m.elapsedSec))
        });
        for (const item of newlyDeadModules) {
          item.record.deadAlertSent = true;
        }
      } else if (newlyDeadModules.length >= 2) {
        // 2. Batch alert for 2+ modules in the same Pod dying together (e.g. user turned off 2 modules at once)
        for (const item of newlyDeadModules) {
          item.record.deadAlertSent = true;
          logIncidentAlert({
            serverId,
            serverName,
            moduleId: item.moduleId,
            moduleName: item.modName,
            alertType: 'DEAD',
            message: `Modul ID ${item.moduleId} (${item.modName}) mati / tidak ada heartbeat selama ${item.elapsedSec} detik!`,
            lastHb: item.record.hb,
            durationSeconds: item.elapsedSec,
            skipTelegram: true // Telegram receives consolidated batch alert below
          });
        }
        sendBatchDeadHeartbeatAlert({
          serverId,
          serverName,
          modules: newlyDeadModules,
          durationSeconds: Math.max(...newlyDeadModules.map(m => m.elapsedSec))
        }).catch(err => {
          console.warn('[Watchdog] Gagal mengirim batch alert Telegram:', err.message);
        });
      } else {
        // 3. Single individual module DEAD alert
        for (const item of newlyDeadModules) {
          item.record.deadAlertSent = true;
          logIncidentAlert({
            serverId,
            serverName,
            moduleId: item.moduleId,
            moduleName: item.modName,
            alertType: 'DEAD',
            message: `Modul ID ${item.moduleId} (${item.modName}) mati / tidak ada heartbeat selama ${item.elapsedSec} detik!`,
            lastHb: item.record.hb,
            durationSeconds: item.elapsedSec
          });
        }
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
            moduleName: modData.name || getModuleNameById(modId),
            hb: modData.hb,
            lastSeenAt: modData.lastSeenAt,
            previousHb: null,
            lastHbChangeAt: modData.lastHbChangeAt,
            isFrozen: modData.isFrozen || false,
            isDead: modData.isDead || false,
            port: modData.port || null,
            totalPackets: modData.totalPackets || 1,
            deadAlertSent: modData.isDead || false,
            frozenAlertSent: modData.isFrozen || false,
            lastAlertAt: 0
          });
        }
      }
      console.log('⚡ Loaded previous fleet snapshot into Watchdog Registry.');
    }
  } catch (_) { }

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
  logIncidentAlert,
  runWatchdogCheck
};

