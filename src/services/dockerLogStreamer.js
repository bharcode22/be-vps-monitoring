const jwt = require('jsonwebtoken');
const { Client } = require('ssh2');
const { spawn } = require('child_process');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;

// Track active streams per socket: Map<socketId, { conn, stream, process }>
const activeStreams = new Map();

function registerDockerStreamHandlers(socket, io) {
  socket.on('docker:start-stream', async (data) => {
    try {
      const { serverId, containerName, token } = data || {};

      // 1. Verify JWT token
      if (!token) {
        return socket.emit('docker:stream-error', { error: 'Otentikasi token diperlukan.' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        return socket.emit('docker:stream-error', { error: 'Token otentikasi tidak valid.' });
      }

      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.status !== 'approved') {
        return socket.emit('docker:stream-error', { error: 'Akses ditolak.' });
      }

      // 2. Fetch server
      const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
      if (!server) {
        return socket.emit('docker:stream-error', { error: 'Server tidak ditemukan.' });
      }

      // Stop any existing stream for this socket
      stopStream(socket.id);

      const safeContainer = String(containerName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
      if (!safeContainer) {
        return socket.emit('docker:stream-error', { error: 'Nama container tidak valid.' });
      }

      const command = `docker logs -f --tail 100 ${safeContainer} 2>&1`;

      if (server.is_local === 1) {
        const child = spawn('docker', ['logs', '-f', '--tail', '100', safeContainer]);

        child.stdout.on('data', (chunk) => {
          socket.emit('docker:stream-data', { containerName: safeContainer, chunk: chunk.toString() });
        });

        child.stderr.on('data', (chunk) => {
          socket.emit('docker:stream-data', { containerName: safeContainer, chunk: chunk.toString() });
        });

        child.on('close', () => {
          socket.emit('docker:stream-ended', { containerName: safeContainer });
        });

        activeStreams.set(socket.id, { process: child });
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
              return socket.emit('docker:stream-error', { error: err.message });
            }

            stream.on('data', (dataChunk) => {
              socket.emit('docker:stream-data', { containerName: safeContainer, chunk: dataChunk.toString() });
            });

            stream.stderr.on('data', (dataChunk) => {
              socket.emit('docker:stream-data', { containerName: safeContainer, chunk: dataChunk.toString() });
            });

            stream.on('close', () => {
              conn.end();
              socket.emit('docker:stream-ended', { containerName: safeContainer });
            });

            activeStreams.set(socket.id, { conn, stream });
          });
        });

        conn.on('error', (err) => {
          socket.emit('docker:stream-error', { error: `Gagal SSH: ${err.message}` });
        });

        conn.connect(sshConfig);
      }
    } catch (err) {
      socket.emit('docker:stream-error', { error: err.message });
    }
  });

  socket.on('docker:stop-stream', () => {
    stopStream(socket.id);
  });

  socket.on('disconnect', () => {
    stopStream(socket.id);
  });
}

function stopStream(socketId) {
  if (activeStreams.has(socketId)) {
    const handle = activeStreams.get(socketId);
    if (handle.stream) {
      try { handle.stream.destroy(); } catch (e) {}
    }
    if (handle.conn) {
      try { handle.conn.end(); } catch (e) {}
    }
    if (handle.process) {
      try { handle.process.kill(); } catch (e) {}
    }
    activeStreams.delete(socketId);
  }
}

module.exports = {
  registerDockerStreamHandlers,
  stopStream
};
