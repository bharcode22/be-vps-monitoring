const jwt = require('jsonwebtoken');
const { Client } = require('ssh2');
const { spawn } = require('child_process');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
const PM2_PATH_ENV = 'export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin;';

// Track active PM2 streams per socket: Map<socketId, { conn, stream, process }>
const activePm2Streams = new Map();

function registerPm2StreamHandlers(socket, io) {
  socket.on('pm2:start-stream', async (data) => {
    try {
      const { serverId, appName, token } = data || {};

      // 1. Verify JWT token
      if (!token) {
        return socket.emit('pm2:stream-error', { error: 'Otentikasi token diperlukan.' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        return socket.emit('pm2:stream-error', { error: 'Token otentikasi tidak valid.' });
      }

      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.status !== 'approved') {
        return socket.emit('pm2:stream-error', { error: 'Akses ditolak.' });
      }

      // 2. Fetch server
      const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
      if (!server) {
        return socket.emit('pm2:stream-error', { error: 'Server tidak ditemukan.' });
      }

      // Stop any existing stream for this socket
      stopPm2Stream(socket.id);

      const safeApp = String(appName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
      if (!safeApp) {
        return socket.emit('pm2:stream-error', { error: 'Nama aplikasi PM2 tidak valid.' });
      }

      const command = `${PM2_PATH_ENV} pm2 logs ${safeApp} --lines 100 2>&1`;

      if (server.is_local === 1) {
        const child = spawn('sh', ['-c', command]);

        child.stdout.on('data', (chunk) => {
          socket.emit('pm2:stream-data', { appName: safeApp, chunk: chunk.toString() });
        });

        child.stderr.on('data', (chunk) => {
          socket.emit('pm2:stream-data', { appName: safeApp, chunk: chunk.toString() });
        });

        child.on('close', () => {
          socket.emit('pm2:stream-ended', { appName: safeApp });
        });

        activePm2Streams.set(socket.id, { process: child });
      } else {
        const conn = new Client();
        const sshConfig = {
          host: server.host,
          port: server.port || 22,
          username: server.username || 'root',
          readyTimeout: 10000
        };

        if (server.auth_type === 'key' && server.private_key) {
          sshConfig.privateKey = server.private_key;
        } else {
          sshConfig.password = server.password;
        }

        conn.on('ready', () => {
          conn.exec(command, (err, stream) => {
            if (err) {
              conn.end();
              return socket.emit('pm2:stream-error', { error: err.message });
            }

            stream.on('data', (dataChunk) => {
              socket.emit('pm2:stream-data', { appName: safeApp, chunk: dataChunk.toString() });
            });

            stream.stderr.on('data', (dataChunk) => {
              socket.emit('pm2:stream-data', { appName: safeApp, chunk: dataChunk.toString() });
            });

            stream.on('close', () => {
              conn.end();
              socket.emit('pm2:stream-ended', { appName: safeApp });
            });

            activePm2Streams.set(socket.id, { conn, stream });
          });
        });

        conn.on('error', (err) => {
          socket.emit('pm2:stream-error', { error: `Gagal SSH: ${err.message}` });
        });

        conn.connect(sshConfig);
      }
    } catch (err) {
      socket.emit('pm2:stream-error', { error: err.message });
    }
  });

  socket.on('pm2:stop-stream', () => {
    stopPm2Stream(socket.id);
  });

  socket.on('disconnect', () => {
    stopPm2Stream(socket.id);
  });
}

function stopPm2Stream(socketId) {
  if (activePm2Streams.has(socketId)) {
    const handle = activePm2Streams.get(socketId);
    if (handle.stream) {
      try { handle.stream.destroy(); } catch (e) {}
    }
    if (handle.conn) {
      try { handle.conn.end(); } catch (e) {}
    }
    if (handle.process) {
      try { handle.process.kill(); } catch (e) {}
    }
    activePm2Streams.delete(socketId);
  }
}

module.exports = {
  registerPm2StreamHandlers,
  stopPm2Stream
};
