// Suppress dotenv banner logs in stdout/docker logs
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const vpsRoutes = require('./routes/vpsRoutes');
const activityLogsRoutes = require('./routes/activityLogsRoutes');
const { collectAllServerMetrics, getAllCachedMetricsList } = require('./services/vpsMonitor');
const { registerDockerStreamHandlers } = require('./services/dockerLogStreamer');
const { registerPm2StreamHandlers } = require('./services/pm2LogStreamer');
const { registerRabbitMqTracerHandlers } = require('./services/rabbitmqTracer');
const { registerInstallationStreamHandlers } = require('./services/installationStreamer');
const { registerSshTerminalHandlers } = require('./services/sshTerminalStreamer');
const { registerMqttSnifferHandlers } = require('./services/mqttSnifferService');
const { initPodActivityService, getPodActivityStatus } = require('./services/podActivityService');
const { initHeartbeatWatchdog } = require('./services/podHeartbeatWatchdogService');
const { setActivitySocketIo } = require('./services/activityLoggerService');
const { registerUserPresenceHandlers } = require('./services/userPresenceService');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 5002;

// Set Activity Logger Socket.IO Instance
setActivitySocketIo(io);

// Middlewares
app.use(cors());
app.use(express.json());
app.set('io', io);

// Routes
app.use('/api/activity-logs', activityLogsRoutes);
app.use('/api', vpsRoutes);

// Socket.io Connection
io.on('connection', (socket) => {
  console.log(`🔌 Client dashboard terhubung: ${socket.id}`);

  // Register real-time User Presence & Activity Tracking
  registerUserPresenceHandlers(socket, io);

  // Instantly send latest cached metrics to newly connected socket
  const cachedList = getAllCachedMetricsList();
  if (cachedList && cachedList.length > 0) {
    socket.emit('metrics_update', cachedList);
  }

  // Send latest POD activity occupancy status to newly connected socket
  getPodActivityStatus().then((activityData) => {
    socket.emit('pod-activity:initial', activityData);
  }).catch(() => { });

  // Trigger fresh collection
  collectAllServerMetrics(io);

  // Register real-time Docker Log Streaming handlers
  registerDockerStreamHandlers(socket, io);

  // Register real-time PM2 Log Streaming handlers
  registerPm2StreamHandlers(socket, io);

  // Register real-time RabbitMQ Firehose Tracer handlers
  registerRabbitMqTracerHandlers(socket, io);

  // Register real-time Batch Installation Stream handlers
  registerInstallationStreamHandlers(socket, io);

  // Register real-time Interactive SSH Terminal handlers
  registerSshTerminalHandlers(socket, io);

  // Register real-time Native MQTT Sniffer & Tester handlers
  registerMqttSnifferHandlers(socket, io);

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Adaptive, self-scheduling metrics polling loop (Prevents overlapping SSH connections)
const MONITOR_INTERVAL = 3000;
let isLoopRunning = false;

async function runPollingLoop() {
  if (isLoopRunning) return;
  isLoopRunning = true;
  try {
    await collectAllServerMetrics(io);
  } catch (err) {
    console.error('Error during scheduled metrics collection:', err.message);
  } finally {
    isLoopRunning = false;
    setTimeout(runPollingLoop, MONITOR_INTERVAL);
  }
}

// Initialize real-time POD Activity MQTT service & Heartbeat Watchdog
initPodActivityService(io);
initHeartbeatWatchdog(io);

// Start continuous polling loop
setTimeout(runPollingLoop, 1000);

// Set HTTP server timeout for long-running SSH deployment tasks (5 minutes)
server.timeout = 300000;
server.keepAliveTimeout = 300000;

server.listen(PORT, () => {
  console.log(`🚀 Server Backend VPS Monitoring berjalan di http://localhost:${PORT}`);
});
