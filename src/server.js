// Suppress dotenv banner logs in stdout/docker logs
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const vpsRoutes = require('./routes/vpsRoutes');
const { collectAllServerMetrics } = require('./services/vpsMonitor');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE']
  }
});

const PORT = process.env.PORT || 5002;

// Middlewares
app.use(cors());
app.use(express.json());
app.set('io', io);

// Routes
app.use('/api', vpsRoutes);

// Socket.io Connection
io.on('connection', (socket) => {
  console.log(`🔌 Client dashboard terhubung: ${socket.id}`);

  // Immediately collect and send metrics on connection
  collectAllServerMetrics(io);

  socket.on('disconnect', () => {
    console.log(`❌ Client disconnected: ${socket.id}`);
  });
});

// Periodic monitoring interval (every 3 seconds)
const MONITOR_INTERVAL = 3000;
setInterval(async () => {
  try {
    await collectAllServerMetrics(io);
  } catch (err) {
    console.error('Error during scheduled metrics collection:', err.message);
  }
}, MONITOR_INTERVAL);

server.listen(PORT, () => {
  console.log(`🚀 Server Backend VPS Monitoring berjalan di http://localhost:${PORT}`);
});
