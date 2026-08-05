const amqp = require('amqplib');
const jwt = require('jsonwebtoken');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const activeSessions = new Map(); // Map<socketId, { conn, ch }>

/**
 * Stop active tracing session for a socket
 * @param {string} socketId 
 */
async function stopTrace(socketId) {
  const session = activeSessions.get(socketId);
  if (session) {
    try {
      if (session.ch) await session.ch.close();
      if (session.conn) await session.conn.close();
    } catch (e) {
      console.warn(`Error closing AMQP trace connection for socket ${socketId}:`, e.message);
    }
    activeSessions.delete(socketId);
  }
}

/**
 * Start Firehose tracing for a socket
 */
function registerRabbitMqTracerHandlers(socket, io) {
  socket.on('rabbitmq:start-trace', async (data) => {
    const { serverId, token, vhost = '/' } = data || {};
    try {
      // 1. Verify token
      if (!token) {
        return socket.emit('rabbitmq:trace-error', { error: 'Otentikasi token diperlukan.' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        return socket.emit('rabbitmq:trace-error', { error: 'Token otentikasi tidak valid.' });
      }

      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.status !== 'approved') {
        return socket.emit('rabbitmq:trace-error', { error: 'Akses ditolak.' });
      }

      // 2. Fetch rabbitmq server settings
      const server = await dbAsync.get('SELECT * FROM rabbitmq_servers WHERE id = ?', [serverId]);
      if (!server) {
        return socket.emit('rabbitmq:trace-error', { error: 'Konfigurasi server RabbitMQ tidak ditemukan.' });
      }

      // Stop any existing trace for this socket
      await stopTrace(socket.id);

      // 3. Connect to RabbitMQ using AMQP protocol
      const username = encodeURIComponent(server.username || 'guest');
      const password = encodeURIComponent(server.password || '');
      const host = server.host;
      const amqpPort = 5672; // Standard AMQP port
      const safeVhost = vhost === '/' ? '' : encodeURIComponent(vhost);
      
      const amqpUrl = `amqp://${username}:${password}@${host}:${amqpPort}/${safeVhost}`;

      console.log(`Connecting to RabbitMQ trace exchange: amqp://${host}:${amqpPort}/${vhost}`);
      const conn = await amqp.connect(amqpUrl, { timeout: 5000 });
      const ch = await conn.createChannel();

      // Create an exclusive, auto-delete queue to receive trace messages
      const { queue } = await ch.assertQueue('', {
        exclusive: true,
        autoDelete: true
      });

      // Bind the queue to the amq.rabbitmq.trace topic exchange
      // '#' matches all routing keys (publish.* and deliver.*)
      await ch.bindQueue(queue, 'amq.rabbitmq.trace', '#');

      // Save session info
      activeSessions.set(socket.id, { conn, ch });
      socket.emit('rabbitmq:trace-connected', { serverId });

      // Start consuming trace messages
      await ch.consume(queue, (msg) => {
        if (msg) {
          const routingKey = msg.fields.routingKey || ''; // e.g. publish.exchangename or deliver.queuename
          const action = routingKey.startsWith('publish') ? 'publish' : (routingKey.startsWith('deliver') ? 'deliver' : 'unknown');
          
          let exchangeName = '';
          let queueName = '';

          if (action === 'publish') {
            exchangeName = routingKey.substring('publish.'.length) || '(default)';
          } else if (action === 'deliver') {
            queueName = routingKey.substring('deliver.'.length) || '';
          }

          const payload = msg.content.toString();
          
          socket.emit('rabbitmq:trace-data', {
            timestamp: new Date().toLocaleTimeString(),
            action, // 'publish' | 'deliver'
            exchange: exchangeName,
            queue: queueName,
            properties: msg.properties,
            body: payload
          });
        }
      }, { noAck: true });

    } catch (err) {
      console.error(`RabbitMQ trace failed for socket ${socket.id}:`, err.message);
      socket.emit('rabbitmq:trace-error', { error: `Gagal trace: ${err.message}` });
      await stopTrace(socket.id);
    }
  });

  socket.on('rabbitmq:stop-trace', async () => {
    await stopTrace(socket.id);
    socket.emit('rabbitmq:trace-stopped');
  });

  socket.on('disconnect', async () => {
    await stopTrace(socket.id);
  });
}

module.exports = {
  registerRabbitMqTracerHandlers
};
