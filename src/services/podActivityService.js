const mqtt = require('mqtt');
const { dbAsync, pool } = require('./db');
const { recordHeartbeatPacket, getHeartbeatSnapshot } = require('./podHeartbeatWatchdogService');
const { recordPodEvent, savePodState } = require('./podStorageService');
const {
  getHeartbeatModulesConfig,
  getHeartbeatThresholdsConfig
} = require('./podHeartbeatConfigService');


const DEFAULT_MQTT_USER = process.env.MQTT_USERNAME;
const DEFAULT_MQTT_PASS = process.env.MQTT_PASSWORD;

// Track active MQTT clients per serverId: Map<serverId, MqttClient>
const activePodClients = new Map();

// In-memory state of all POD V3 units: Map<serverId, PodActivityState>
const podStateMap = new Map();

// In-memory ring buffer for recent activity logs (fast access)
const recentActivityLogs = [];
const MAX_RECENT_LOGS = 150;

let socketIoInstance = null;
let isInitialized = false;
const daemonStartTime = Date.now();

/**
 * Standardize and parse occupancy value from raw MQTT payload
 * Returns: 1 (Occupied), 0 (Vacant), or null (Unrecognized)
 */
function parseOccupancyValue(rawPayload) {
  if (rawPayload === null || rawPayload === undefined) return null;
  const str = String(rawPayload).trim();

  if (str === '1' || str.toLowerCase() === 'true' || str.toLowerCase() === 'occupied' || str.toLowerCase() === 'pob') {
    return 1;
  }
  if (str === '0' || str.toLowerCase() === 'false' || str.toLowerCase() === 'vacant' || str.toLowerCase() === 'empty') {
    return 0;
  }

  try {
    const json = JSON.parse(str);
    if (json.value !== undefined) return parseOccupancyValue(json.value);
    if (json.state !== undefined) return parseOccupancyValue(json.state);
    if (json.pob !== undefined) return parseOccupancyValue(json.pob);
    if (json.pob_state !== undefined) return parseOccupancyValue(json.pob_state);
    if (json.pod_state !== undefined) return parseOccupancyValue(json.pod_state);
    if (json.status !== undefined) return parseOccupancyValue(json.status);
    if (json.occupied !== undefined) return parseOccupancyValue(json.occupied);
  } catch (_) { }

  const num = Number(str);
  if (!isNaN(num)) {
    return num >= 1 ? 1 : 0;
  }

  return null;
}

/**
 * Initialize PostgreSQL table for occupancy history if it doesn't exist
 */
async function initDatabaseSchema() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pod_occupancy_logs (
        id SERIAL PRIMARY KEY,
        server_id INT NOT NULL,
        server_name VARCHAR(100),
        server_code VARCHAR(50),
        server_host VARCHAR(50),
        state_value INT NOT NULL,
        state_label VARCHAR(30) NOT NULL,
        topic VARCHAR(255),
        raw_payload TEXT,
        duration_seconds INT DEFAULT 0,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_occupancy_logs_server_id ON pod_occupancy_logs(server_id);
      CREATE INDEX IF NOT EXISTS idx_occupancy_logs_created_at ON pod_occupancy_logs(created_at DESC);
    `);
  } catch (err) {
    console.warn('⚠️ Could not initialize pod_occupancy_logs schema:', err.message);
  }
}

/**
 * Record an activity transition into memory buffer and database
 */
async function recordActivityTransition(podState, stateValue, topic, rawPayload, durationSeconds = 0) {
  const stateLabel = stateValue === 1 ? 'OCCUPIED' : 'VACANT';
  const timestamp = new Date();

  const logEntry = {
    id: `act_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
    serverId: podState.id,
    serverName: podState.name,
    serverCode: podState.code,
    serverHost: podState.host,
    stateValue,
    stateLabel,
    topic,
    rawPayload: String(rawPayload),
    durationSeconds,
    createdAt: timestamp.toISOString()
  };

  // Add to in-memory buffer
  recentActivityLogs.unshift(logEntry);
  if (recentActivityLogs.length > MAX_RECENT_LOGS) {
    recentActivityLogs.pop();
  }

  // Record to Pod-Centric JSON-Lines daily file and update pod state
  recordPodEvent({
    podId: podState.id,
    podName: podState.name,
    eventType: 'OCCUPIED_CHANGE',
    message: `Status kursi berganti menjadi ${stateLabel}`,
    downtimeSeconds: durationSeconds,
    data: { stateValue, stateLabel, durationSeconds, topic },
    timestamp: timestamp.getTime()
  });
  savePodState(podState.id, {
    name: podState.name,
    host: podState.host,
    stateValue,
    stateText: stateLabel,
    isOccupied: stateValue === 1,
    lastSeenAt: timestamp.toISOString()
  });

  // Persist into database asynchronously (backup)
  try {
    await pool.query(`
      INSERT INTO pod_occupancy_logs 
        (server_id, server_name, server_code, server_host, state_value, state_label, topic, raw_payload, duration_seconds, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      podState.id,
      podState.name,
      podState.code,
      podState.host,
      stateValue,
      stateLabel,
      topic,
      String(rawPayload).slice(0, 1000),
      durationSeconds,
      timestamp
    ]);
  } catch (dbErr) {
    console.warn('Could not insert occupancy log to DB:', dbErr.message);
  }

  return logEntry;
}

/**
 * Connect to MQTT broker of a single POD V3
 */
function connectPodMqtt(pod) {
  const brokerUrl = `tcp://${pod.host}:1883`;

  // Close existing client if any
  if (activePodClients.has(pod.id)) {
    try {
      activePodClients.get(pod.id).end(true);
    } catch (_) { }
    activePodClients.delete(pod.id);
  }

  // Initialize or get state
  let podState = podStateMap.get(pod.id);
  if (!podState) {
    podState = {
      id: pod.id,
      name: pod.name,
      code: pod.code,
      host: pod.host,
      podVersion: pod.pod_version || 'v3',
      brokerUrl,
      brokerConnected: false,
      isOccupied: false,
      stateValue: null, // null = unknown / pending data
      stateText: 'UNKNOWN', // 'OCCUPIED' | 'VACANT' | 'UNKNOWN'
      lastTopic: null,
      lastPayload: null,
      lastChangedAt: null,
      lastSeenAt: null
    };
    podStateMap.set(pod.id, podState);
  } else {
    podState.brokerUrl = brokerUrl;
  }

  const client = mqtt.connect(brokerUrl, {
    username: DEFAULT_MQTT_USER,
    password: DEFAULT_MQTT_PASS,
    connectTimeout: 5000,
    reconnectPeriod: 4000,
    keepalive: 30,
    clean: true
  });

  client.on('connect', () => {
    podState.brokerConnected = true;

    // Subscribe to mod_chair/pob_state, chair sensors, and mod_server module heartbeats for monitoring POD activity
    // Using '+' wildcard for MAC address and module IDs
    const targetTopics = [
      'pod/+/2.0/mod_chair/pob_state',
      'pod/+/mod_chair/pob_state',
      'mod_chair/pob_state',
      'pod/+/2.0/mod_chair/temperature',
      'pod/+/mod_chair/temperature',
      'mod_chair/temperature',
      'pod/+/2.0/mod_chair/humidity',
      'pod/+/mod_chair/humidity',
      'mod_chair/humidity',
      'mod_server/+/data',
      'mod_server/#'
    ];

    client.subscribe(targetTopics, { qos: 0 }, (err) => {
      if (err) {
        console.warn(`MQTT subscribe error on ${pod.name} (${pod.host}):`, err.message);
      }
    });

    if (socketIoInstance) {
      socketIoInstance.emit('pod-activity:broker-status', {
        serverId: pod.id,
        connected: true,
        brokerUrl,
        timestamp: Date.now()
      });
    }
  });

  client.on('reconnect', () => {
    podState.brokerConnected = true;
  });

  client.on('message', async (topic, message) => {
    podState.brokerConnected = true;
    const rawStr = message.toString('utf-8');

    podState.lastSeenAt = new Date().toISOString();

    // Emit raw MQTT log for the live activity feed in frontend
    if (socketIoInstance) {
      socketIoInstance.emit('pod-activity:mqtt-log', {
        serverId: pod.id,
        serverName: pod.name,
        topic,
        payload: rawStr,
        timestamp: podState.lastSeenAt
      });
    }

    // Process and record module heartbeats into Watchdog
    if (topic.includes('mod_server') || rawStr.includes('"hb"')) {
      try {
        let parsed = null;
        if (rawStr.startsWith('{')) parsed = JSON.parse(rawStr);
        let modId = null;
        const match = topic.match(/mod_server\/(\d+)/);
        if (match) modId = parseInt(match[1], 10);
        else if (parsed?.id) modId = parseInt(parsed.id, 10);

        if (modId && (parsed?.hb !== undefined || !isNaN(Number(rawStr)))) {
          const hbVal = parsed?.hb !== undefined ? parsed.hb : Number(rawStr);
          recordHeartbeatPacket({
            serverId: pod.id,
            serverName: pod.name,
            moduleId: modId,
            hb: hbVal,
            port: parsed?.port || null,
            timestamp: Date.now()
          });
        }
      } catch (_) {}
    }

    // Only process occupancy state if the topic is specifically mod_chair/pob_state
    const isOccupancyTopic = topic === 'mod_chair/pob_state' || 
                             topic.endsWith('/mod_chair/pob_state') || 
                             topic === 'pob_state';
    if (!isOccupancyTopic) {
      return;
    }

    const parsedVal = parseOccupancyValue(rawStr);
    if (parsedVal === null) return; // Skip unrecognizable packets

    podState.lastTopic = topic;
    podState.lastPayload = rawStr;

    const isTransition = podState.stateValue !== parsedVal;
    const now = new Date();
    let durationSeconds = 0;

    if (podState.lastChangedAt) {
      durationSeconds = Math.max(0, Math.floor((now.getTime() - new Date(podState.lastChangedAt).getTime()) / 1000));
    }

    if (isTransition) {
      const prevValue = podState.stateValue;
      podState.stateValue = parsedVal;
      podState.isOccupied = parsedVal === 1;
      podState.stateText = parsedVal === 1 ? 'OCCUPIED' : 'VACANT';
      podState.lastChangedAt = now.toISOString();

      const logEntry = await recordActivityTransition(
        podState,
        parsedVal,
        topic,
        rawStr,
        prevValue !== null ? durationSeconds : 0
      );

      // Emit live real-time update to all connected dashboard users
      if (socketIoInstance) {
        socketIoInstance.emit('pod-activity:state-changed', {
          pod: { ...podState },
          log: logEntry,
          summary: getSummaryStats()
        });
      }
    }
  });

  client.on('error', () => {
    podState.brokerConnected = false;
  });

  client.on('offline', () => {
    podState.brokerConnected = false;
    if (socketIoInstance) {
      socketIoInstance.emit('pod-activity:broker-status', {
        serverId: pod.id,
        connected: false,
        brokerUrl,
        timestamp: Date.now()
      });
    }
  });

  client.on('close', () => {
    podState.brokerConnected = false;
  });

  activePodClients.set(pod.id, client);
}

/**
 * Synchronize and connect to all registered POD V3 servers
 */
async function syncAndConnectAllV3Pods() {
  try {
    const pods = await dbAsync.all(
      "SELECT id, name, host, port, code, pod_version FROM servers WHERE LOWER(pod_version) = 'v3' ORDER BY name ASC;"
    );

    // Update podStateMap entries
    for (const pod of pods) {
      connectPodMqtt(pod);
    }

    // Clean up removed servers
    const currentPodIds = new Set(pods.map(p => p.id));
    for (const [id, client] of activePodClients.entries()) {
      if (!currentPodIds.has(id)) {
        try { client.end(true); } catch (_) { }
        activePodClients.delete(id);
        podStateMap.delete(id);
      }
    }
  } catch (err) {
    console.error('Error synchronizing POD V3 servers for MQTT activity:', err.message);
  }
}

/**
 * Calculate summary statistics for active POD units
 */
function getSummaryStats() {
  const podList = Array.from(podStateMap.values());
  const totalPods = podList.length;
  const occupiedCount = podList.filter(p => p.stateValue === 1).length;
  const vacantCount = podList.filter(p => p.stateValue === 0).length;
  const unknownCount = podList.filter(p => p.stateValue === null).length;
  const brokersConnected = podList.filter(p => p.brokerConnected || (p.lastPayload !== null && p.lastPayload !== undefined)).length;

  return {
    totalPods,
    occupiedCount,
    vacantCount,
    unknownCount,
    brokersConnected
  };
}

/**
 * Main Service Initialization: Connects to DB and all POD V3 MQTT Brokers
 */
async function initPodActivityService(io) {
  if (io) {
    socketIoInstance = io;
  }

  if (isInitialized) return;
  isInitialized = true;

  console.log('🚀 Initializing POD Activity (mod_chair/pob_state) Real-Time Service...');
  await initDatabaseSchema();
  await syncAndConnectAllV3Pods();

  // Periodic resync of servers list every 60 seconds
  setInterval(syncAndConnectAllV3Pods, 60000);

  // Auto-heal watchdog: Check and reconnect disconnected MQTT brokers every 25 seconds
  setInterval(() => {
    for (const [id, client] of activePodClients.entries()) {
      if (client && !client.connected && !client.reconnecting) {
        try {
          client.reconnect();
        } catch (_) {}
      }
    }
  }, 25000);
}

/**
 * Get background ingestion daemon status summary
 */
function getIngestionDaemonStatus() {
  const now = Date.now();
  const pods = Array.from(podStateMap.values()).map(p => {
    const client = activePodClients.get(p.id);
    const isConnected = Boolean(client && client.connected);
    return {
      id: p.id,
      name: p.name,
      host: p.host,
      code: p.code,
      connected: isConnected,
      lastSeenAt: p.lastSeenAt,
      stateText: p.stateText,
      brokerUrl: p.brokerUrl
    };
  });

  const totalPods = pods.length;
  const connectedPods = pods.filter(p => p.connected).length;
  const uptimeSeconds = Math.floor((now - daemonStartTime) / 1000);

  return {
    status: 'active',
    uptimeSeconds,
    totalPods,
    connectedPods,
    offlinePods: totalPods - connectedPods,
    healthPercent: totalPods > 0 ? Math.round((connectedPods / totalPods) * 100) : 100,
    timestamp: new Date().toISOString(),
    pods
  };
}

/**
 * Get current snapshot of all POD activities, summary, and recent logs
 */
async function getPodActivityStatus() {
  // Populate durations in real-time
  const now = Date.now();
  const pods = Array.from(podStateMap.values()).map(p => {
    let durationSeconds = 0;
    if (p.lastChangedAt) {
      durationSeconds = Math.max(0, Math.floor((now - new Date(p.lastChangedAt).getTime()) / 1000));
    }
    return {
      ...p,
      durationSeconds
    };
  });

  return {
    summary: getSummaryStats(),
    pods,
    recentLogs: recentActivityLogs.slice(0, 50),
    heartbeatSnapshot: getHeartbeatSnapshot(),
    modulesConfig: getHeartbeatModulesConfig(),
    thresholdsConfig: getHeartbeatThresholdsConfig()
  };
}


/**
 * Get historical occupancy logs with pagination
 */
async function getOccupancyHistory(limit = 50, offset = 0, serverId = null) {
  try {
    let query = 'SELECT * FROM pod_occupancy_logs';
    const params = [];

    if (serverId) {
      query += ' WHERE server_id = $1';
      params.push(serverId);
    }

    query += ' ORDER BY created_at DESC LIMIT $' + (params.length + 1) + ' OFFSET $' + (params.length + 2) + ';';
    params.push(limit, offset);

    const res = await pool.query(query, params);
    return res.rows;
  } catch (err) {
    console.error('Error fetching occupancy history:', err.message);
    return recentActivityLogs.slice(0, limit);
  }
}

/**
 * Test Simulator: Simulate a payload transition on a POD
 */
async function simulatePodActivity({ serverId, value, topic = 'mod_chair/pob_state' }) {
  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!pod) throw new Error('Unit POD tidak ditemukan.');

  const parsedVal = parseOccupancyValue(value);
  if (parsedVal === null) throw new Error('Nilai harus 1 (Ada Orang) atau 0 (Kosong).');

  let podState = podStateMap.get(pod.id);
  if (!podState) {
    connectPodMqtt(pod);
    podState = podStateMap.get(pod.id);
  }

  // Publish to real MQTT broker if connected
  const client = activePodClients.get(pod.id);
  if (client && client.connected) {
    client.publish(topic, String(parsedVal), { qos: 0 }, (err) => {
      if (err) console.warn('Could not publish simulation packet:', err.message);
    });
  }

  // Update in-memory state directly as well
  const now = new Date();
  let durationSeconds = 0;
  if (podState.lastChangedAt) {
    durationSeconds = Math.max(0, Math.floor((now.getTime() - new Date(podState.lastChangedAt).getTime()) / 1000));
  }

  podState.stateValue = parsedVal;
  podState.isOccupied = parsedVal === 1;
  podState.stateText = parsedVal === 1 ? 'OCCUPIED' : 'VACANT';
  podState.lastTopic = topic;
  podState.lastPayload = String(parsedVal);
  podState.lastChangedAt = now.toISOString();
  podState.lastSeenAt = now.toISOString();

  const logEntry = await recordActivityTransition(
    podState,
    parsedVal,
    topic,
    String(parsedVal),
    durationSeconds
  );

  if (socketIoInstance) {
    socketIoInstance.emit('pod-activity:state-changed', {
      pod: { ...podState },
      log: logEntry,
      summary: getSummaryStats()
    });
  }

  return {
    success: true,
    message: `Berhasil mensimulasikan status ${parsedVal === 1 ? 'Ada Orang (1)' : 'Kosong (0)'} pada ${pod.name}`,
    pod: podState,
    log: logEntry
  };
}

module.exports = {
  initPodActivityService,
  getPodActivityStatus,
  getOccupancyHistory,
  simulatePodActivity,
  syncAndConnectAllV3Pods,
  getIngestionDaemonStatus
};
