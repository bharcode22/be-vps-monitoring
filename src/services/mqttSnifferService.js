const mqtt = require('mqtt');
const jwt = require('jsonwebtoken');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const DEFAULT_MQTT_USER = process.env.MQTT_USERNAME;
const DEFAULT_MQTT_PASS = process.env.MQTT_PASSWORD;

// Map<brokerUrl, mqttClient>
const clientPool = new Map();
// Map<brokerUrl, Map<topic, packetData>>
const retainedCache = new Map();
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

    // Update cache for this broker
    if (!retainedCache.has(brokerUrl)) {
      retainedCache.set(brokerUrl, new Map());
    }

    // Special case: Preserve duration for track/seek if pod only sends position on heartbeat
    if (topic === 'mod_audio/track/seek' && payloadJson && payloadJson.position !== undefined && payloadJson.duration === undefined) {
      if (retainedCache.get(brokerUrl).has(topic)) {
        const prevPacket = retainedCache.get(brokerUrl).get(topic);
        if (prevPacket && prevPacket.payloadJson && prevPacket.payloadJson.duration !== undefined) {
          payloadJson.duration = prevPacket.payloadJson.duration;
          packetData.payloadJson = payloadJson;
          packetData.payload = JSON.stringify(payloadJson);
        }
      }
    }

    retainedCache.get(brokerUrl).set(topic, packetData);

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
const activePodSockets = new Map(); // socket.id -> socket.io-client instance

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

      const url = normalizeBrokerUrl(targetUrl);
      const session = { socket, brokerUrl: url };
      activeSniffingSockets.set(socket.id, session);
      
      // Make sure we have a client for this broker
      const client = getMqttClient(url);
      if (client.connected) {
        socket.emit('mqtt:status', { connected: true, brokerUrl: url, timestamp: Date.now() });
        
        // Dump the retained cache to the newly connected socket
        if (retainedCache.has(url)) {
          const cacheForUrl = retainedCache.get(url);
          console.log(`Dumping ${cacheForUrl.size} retained messages to new socket for ${url}`);
          for (const [_, packetData] of cacheForUrl) {
            socket.emit('mqtt:packet', packetData);
          }
        }
      }
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

  socket.on('pod-socket:start-sniff', async (data) => {
    try {
      const { host, port = 3000 } = data || {};
      if (!host) return;

      if (activePodSockets.has(socket.id)) {
        const oldClient = activePodSockets.get(socket.id);
        try { oldClient.disconnect(); } catch (_) {}
        activePodSockets.delete(socket.id);
      }

      const ioClient = require('socket.io-client');
      const podClient = ioClient(`http://${host}:${port}`, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        timeout: 5000
      });

      activePodSockets.set(socket.id, podClient);

      podClient.on('connect', () => {
        socket.emit('pod-socket:status', { connected: true, host, port });
      });

      podClient.on('connect_error', (err) => {
        socket.emit('pod-socket:status', { connected: false, host, port, error: err.message });
      });

      podClient.on('disconnect', () => {
        socket.emit('pod-socket:status', { connected: false, host, port });
      });

      podClient.onAny((event, ...args) => {
        const payload = args.length === 1 ? args[0] : args;
        socket.emit('pod-socket:packet', {
          event,
          payload,
          timestamp: Date.now()
        });
      });
    } catch (err) {
      socket.emit('pod-socket:error', { error: err.message });
    }
  });

  socket.on('pod-socket:stop-sniff', () => {
    if (activePodSockets.has(socket.id)) {
      const podClient = activePodSockets.get(socket.id);
      try { podClient.disconnect(); } catch (_) {}
      activePodSockets.delete(socket.id);
    }
  });

  socket.on('pod-socket:emit', async (data) => {
    try {
      const { host, port = 3000, event, payload, token } = data || {};
      if (!token) return socket.emit('pod-socket:error', { error: 'Otentikasi token diperlukan.' });
      if (!host || !event) return socket.emit('pod-socket:error', { error: 'Host dan event wajib diisi.' });

      // If active pod socket is available for this client, use it; otherwise create temporary client
      let podClient = activePodSockets.get(socket.id);
      if (podClient && podClient.connected) {
        podClient.emit(event, payload);
        socket.emit('pod-socket:success', { host, port, event, payload });
      } else {
        const ioClient = require('socket.io-client');
        const targetSocketUrl = `http://${host}:${port}`;
        const tempClient = ioClient(targetSocketUrl, {
          transports: ['websocket', 'polling'],
          timeout: 4000
        });

        tempClient.on('connect', () => {
          tempClient.emit(event, payload);
          socket.emit('pod-socket:success', { host, port, event, payload });
          setTimeout(() => tempClient.disconnect(), 1000);
        });

        tempClient.on('connect_error', (err) => {
          socket.emit('pod-socket:error', { error: `Gagal terhubung ke http://${host}:${port}: ${err.message}` });
          tempClient.disconnect();
        });
      }
    } catch (err) {
      socket.emit('pod-socket:error', { error: err.message });
    }
  });

  socket.on('disconnect', () => {
    activeSniffingSockets.delete(socket.id);
    if (activePodSockets.has(socket.id)) {
      const podClient = activePodSockets.get(socket.id);
      try { podClient.disconnect(); } catch (_) {}
      activePodSockets.delete(socket.id);
    }
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
