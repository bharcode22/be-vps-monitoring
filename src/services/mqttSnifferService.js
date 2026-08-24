const mqtt = require('mqtt');
const jwt = require('jsonwebtoken');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_MQTT_USER = process.env.MQTT_USERNAME;
const DEFAULT_MQTT_PASS = process.env.MQTT_PASSWORD;

// Map<brokerUrl, mqttClient>
const clientPool = new Map();
// Map<socketId, { socket, brokerUrl }>
const activeSniffingSockets = new Map();

/**
 * Format broker URL cleanly (e.g. "192.168.199.30" -> "tcp://192.168.199.30:1883")
 */
function normalizeBrokerUrl(inputUrl) {
  if (!inputUrl) return 'tcp://127.0.0.1:1883';
  let url = inputUrl.trim();
  if (!url.startsWith('tcp://') && !url.startsWith('mqtt://') && !url.startsWith('ws://')) {
    url = `tcp://${url}`;
  }
  if (!url.includes(':', 6)) {
    url = `${url}:1883`;
  }
  return url;
}

/**
 * Get or create MQTT client connection for a specific broker URL
 */
function getMqttClient(brokerUrlInput, username = DEFAULT_MQTT_USER, password = DEFAULT_MQTT_PASS) {
  const brokerUrl = normalizeBrokerUrl(brokerUrlInput);

  if (clientPool.has(brokerUrl)) {
    const existing = clientPool.get(brokerUrl);
    if (existing && existing.connected) {
      return existing;
    }
  }

  console.log(`Connecting to MQTT broker: ${brokerUrl} as ${username}...`);

  const client = mqtt.connect(brokerUrl, {
    username,
    password,
    connectTimeout: 4000,
    reconnectPeriod: 3000,
    clean: true
  });

  client.on('connect', () => {
    console.log(`Connected to MQTT Broker: ${brokerUrl}`);
    // Subscribe to all pod topics
    client.subscribe(['pod/#', 'socket/#', '#'], { qos: 0 }, (err) => {
      if (err) console.error(`Error subscribing on ${brokerUrl}:`, err.message);
      else console.log(`Subscribed to wildcard topics on ${brokerUrl}`);
    });

    // Notify sockets listening to this broker
    for (const [_, session] of activeSniffingSockets) {
      if (session.brokerUrl === brokerUrl) {
        try {
          session.socket.emit('mqtt:status', { connected: true, brokerUrl, timestamp: Date.now() });
        } catch (_) { }
      }
    }
  });

  client.on('error', (err) => {
    console.warn(`MQTT Broker error on ${brokerUrl}:`, err.message);
    for (const [_, session] of activeSniffingSockets) {
      if (session.brokerUrl === brokerUrl) {
        try {
          session.socket.emit('mqtt:status', { connected: false, brokerUrl, error: err.message, timestamp: Date.now() });
        } catch (_) { }
      }
    }
  });

  client.on('offline', () => {
    for (const [_, session] of activeSniffingSockets) {
      if (session.brokerUrl === brokerUrl) {
        try {
          session.socket.emit('mqtt:status', { connected: false, brokerUrl, timestamp: Date.now() });
        } catch (_) { }
      }
    }
  });

  client.on('message', (topic, message, packet) => {
    const payloadStr = message.toString('utf-8');
    let payloadJson = null;
    try {
      payloadJson = JSON.parse(payloadStr);
    } catch (_) { }

    const packetData = {
      id: `pkt_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      brokerUrl,
      topic,
      payload: payloadStr,
      payloadJson,
      qos: packet.qos || 0,
      retain: packet.retain || false,
      timestamp: Date.now()
    };

    // Broadcast to sockets attached to this broker
    for (const [_, session] of activeSniffingSockets) {
      if (!session.brokerUrl || session.brokerUrl === brokerUrl) {
        try {
          session.socket.emit('mqtt:packet', packetData);
        } catch (_) { }
      }
    }
  });

  clientPool.set(brokerUrl, client);
  return client;
}

/**
 * Publish a message to any topic on the target MQTT broker
 */
async function publishMqttMessage({ topic, payload, qos = 0, retain = false, brokerUrl, serverId, brokerHost, username = DEFAULT_MQTT_USER, password = DEFAULT_MQTT_PASS }) {
  if (!topic) throw new Error('Topic harus diisi.');

  let targetUrl = brokerUrl;
  if (!targetUrl && (serverId || brokerHost)) {
    if (serverId) {
      const srv = await dbAsync.get('SELECT host FROM servers WHERE id = ?', [serverId]);
      if (srv && srv.host) targetUrl = `tcp://${srv.host}:1883`;
    } else if (brokerHost) {
      targetUrl = `tcp://${brokerHost}:1883`;
    }
  }

  const finalUrl = normalizeBrokerUrl(targetUrl || 'tcp://127.0.0.1:1883');
  const client = getMqttClient(finalUrl, username, password);

  return new Promise((resolve, reject) => {
    const payloadStr = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');

    // Check connection status
    if (!client.connected) {
      const timeout = setTimeout(() => {
        reject(new Error(`Klien MQTT belum terhubung ke broker. Pastikan service MQTT aktif di ${finalUrl}`));
      }, 3500);

      client.once('connect', () => {
        clearTimeout(timeout);
        client.publish(topic, payloadStr, { qos, retain }, (err) => {
          if (err) reject(err);
          else resolve({ success: true, topic, brokerUrl: finalUrl, payload: payloadStr, timestamp: Date.now() });
        });
      });
      return;
    }

    client.publish(topic, payloadStr, { qos, retain }, (err) => {
      if (err) reject(err);
      else resolve({ success: true, topic, brokerUrl: finalUrl, payload: payloadStr, timestamp: Date.now() });
    });
  });
}

/**
 * Register MQTT sniffer handlers on Socket.io connection
 */
function registerMqttSnifferHandlers(socket, io) {
  socket.on('mqtt:start-sniff', async (data) => {
    try {
      const { token, brokerUrl, serverId, brokerHost } = data || {};

      // Verify JWT Auth
      if (!token) return socket.emit('mqtt:error', { error: 'Otentikasi diperlukan.' });
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (_) {
        return socket.emit('mqtt:error', { error: 'Token tidak valid.' });
      }

      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.status !== 'approved') {
        return socket.emit('mqtt:error', { error: 'Akses ditolak.' });
      }

      let targetUrl = brokerUrl;
      if (!targetUrl && (serverId || brokerHost)) {
        if (serverId) {
          const srv = await dbAsync.get('SELECT host FROM servers WHERE id = ?', [serverId]);
          if (srv && srv.host) targetUrl = `tcp://${srv.host}:1883`;
        } else if (brokerHost) {
          targetUrl = `tcp://${brokerHost}:1883`;
        }
      }

      const finalUrl = normalizeBrokerUrl(targetUrl || 'tcp://127.0.0.1:1883');
      activeSniffingSockets.set(socket.id, { socket, brokerUrl: finalUrl });

      const client = getMqttClient(finalUrl);

      socket.emit('mqtt:status', {
        connected: client.connected,
        brokerUrl: finalUrl,
        timestamp: Date.now()
      });
    } catch (err) {
      socket.emit('mqtt:error', { error: err.message });
    }
  });

  socket.on('mqtt:stop-sniff', () => {
    activeSniffingSockets.delete(socket.id);
  });

  socket.on('mqtt:inject-packet', async (data) => {
    try {
      const { topic, payload, qos = 0, retain = false, brokerUrl, serverId, brokerHost, token } = data || {};
      if (!token) return socket.emit('mqtt:inject-error', { error: 'Otentikasi token diperlukan.' });

      const result = await publishMqttMessage({ topic, payload, qos, retain, brokerUrl, serverId, brokerHost });
      socket.emit('mqtt:inject-success', result);
    } catch (err) {
      socket.emit('mqtt:inject-error', { error: err.message });
    }
  });

  socket.on('disconnect', () => {
    activeSniffingSockets.delete(socket.id);
  });
}

module.exports = {
  getMqttClient,
  publishMqttMessage,
  registerMqttSnifferHandlers,
  normalizeBrokerUrl,
  DEFAULT_MQTT_USER,
  DEFAULT_MQTT_PASS
};
