const jwt = require('jsonwebtoken');
const { Client } = require('ssh2');
const { spawn } = require('child_process');
const dbAsync = require('./db');
const { decrypt } = require('../utils/crypto');

const JWT_SECRET = process.env.JWT_SECRET;

// Map<socketId, { conn, stream, process }
const activeSessions = new Map();

function registerSshTerminalHandlers(socket, io) {
  socket.on('terminal:init', async (data) => {
    try {
      const { serverId, cols = 80, rows = 24, token } = data || {};

      // 1. Verify JWT Authentication Token
      if (!token) {
        return socket.emit('terminal:error', { error: 'Otentikasi token diperlukan.' });
      }

      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch (e) {
        return socket.emit('terminal:error', { error: 'Token otentikasi tidak valid atau telah kadaluarsa.' });
      }

      if (!serverId) {
        return socket.emit('terminal:error', { error: 'Parameter serverId harus diisi.' });
      }

      // Check user approval status in database
      const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (!user || user.status !== 'approved') {
        return socket.emit('terminal:error', { error: 'Akses ditolak. Akun belum disetujui atau dinonaktifkan.' });
      }

      // Stop any existing active terminal session for this socket
      stopTerminalSession(socket.id);

      // 2. Fetch server details from database
      const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
      if (!server) {
        return socket.emit('terminal:error', { error: 'Server tidak ditemukan di database.' });
      }

      // 3. Local Server Shell (is_local === 1)
      if (server.is_local === 1) {
        const shellProcess = spawn(process.env.SHELL || '/bin/bash', ['-i'], {
          env: {
            ...process.env,
            TERM: 'xterm-256color',
            COLUMNS: String(cols),
            LINES: String(rows)
          }
        });

        shellProcess.stdout.on('data', (chunk) => {
          socket.emit('terminal:data', chunk.toString('utf-8'));
        });

        shellProcess.stderr.on('data', (chunk) => {
          socket.emit('terminal:data', chunk.toString('utf-8'));
        });

        shellProcess.on('close', () => {
          socket.emit('terminal:closed');
          activeSessions.delete(socket.id);
        });

        activeSessions.set(socket.id, { process: shellProcess, stream: shellProcess.stdin });
        socket.emit('terminal:ready', {
          serverName: server.name,
          host: server.host,
          username: server.username || 'local'
        });
        return;
      }

      // 4. Remote Server SSH PTY Shell Connection
      const conn = new Client();
      let isHandled = false;

      const sshTimeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          try { conn.end(); } catch (_) {}
          socket.emit('terminal:error', { error: 'Koneksi SSH ke server waktu habis (timeout 15 detik)' });
        }
      }, 15000);

      let privateKey = null;
      let password = null;

      try {
        if (server.auth_type === 'key' && server.private_key) {
          privateKey = decrypt(server.private_key);
        } else if (server.password) {
          password = decrypt(server.password);
        }
      } catch (decryptErr) {
        clearTimeout(sshTimeout);
        return socket.emit('terminal:error', { error: `Gagal mendekripsi kredensial SSH: ${decryptErr.message}` });
      }

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'root',
        readyTimeout: 10000
      };

      if (privateKey) {
        sshConfig.privateKey = privateKey;
      } else {
        sshConfig.password = password;
      }

      conn.on('ready', () => {
        clearTimeout(sshTimeout);
        isHandled = true;

        conn.shell(
          {
            term: 'xterm-256color',
            cols: parseInt(cols, 10) || 80,
            rows: parseInt(rows, 10) || 24
          },
          (err, stream) => {
            if (err) {
              try { conn.end(); } catch (_) {}
              return socket.emit('terminal:error', { error: `Gagal membuka shell session: ${err.message}` });
            }

            activeSessions.set(socket.id, { conn, stream });

            stream.on('data', (dataChunk) => {
              socket.emit('terminal:data', dataChunk.toString('utf-8'));
            });

            stream.stderr.on('data', (dataChunk) => {
              socket.emit('terminal:data', dataChunk.toString('utf-8'));
            });

            stream.on('close', () => {
              socket.emit('terminal:closed');
              stopTerminalSession(socket.id);
            });

            socket.emit('terminal:ready', {
              serverName: server.name,
              host: server.host,
              username: server.username || 'root'
            });
          }
        );
      });

      conn.on('error', (err) => {
        clearTimeout(sshTimeout);
        if (!isHandled) {
          isHandled = true;
          socket.emit('terminal:error', { error: `Gagal terhubung SSH: ${err.message}` });
          stopTerminalSession(socket.id);
        }
      });

      conn.on('close', () => {
        clearTimeout(sshTimeout);
        socket.emit('terminal:closed');
        stopTerminalSession(socket.id);
      });

      try {
        conn.connect(sshConfig);
      } catch (connErr) {
        clearTimeout(sshTimeout);
        socket.emit('terminal:error', { error: `Kesalahan inisialisasi koneksi SSH: ${connErr.message}` });
        stopTerminalSession(socket.id);
      }

    } catch (err) {
      socket.emit('terminal:error', { error: err.message });
    }
  });

  // Client keystroke or data input
  socket.on('terminal:input', (payload) => {
    const session = activeSessions.get(socket.id);
    if (session && session.stream && payload && typeof payload.data === 'string') {
      try {
        session.stream.write(payload.data);
      } catch (e) {
        console.error('Error writing to terminal stream:', e.message);
      }
    }
  });

  // Terminal window resize event (dynamic rows & cols)
  socket.on('terminal:resize', (payload) => {
    const session = activeSessions.get(socket.id);
    if (session && session.stream && payload) {
      const cols = parseInt(payload.cols, 10);
      const rows = parseInt(payload.rows, 10);
      if (cols > 0 && rows > 0 && typeof session.stream.setWindow === 'function') {
        try {
          session.stream.setWindow(rows, cols, 0, 0);
        } catch (_) {}
      }
    }
  });

  // Stop / Close session explicitly
  socket.on('terminal:close', () => {
    stopTerminalSession(socket.id);
  });

  // Clean up on socket disconnect
  socket.on('disconnect', () => {
    stopTerminalSession(socket.id);
  });
}

/**
 * Terminate and clean up any active terminal connection for a given socket ID
 */
function stopTerminalSession(socketId) {
  if (activeSessions.has(socketId)) {
    const session = activeSessions.get(socketId);
    if (session.stream) {
      try { session.stream.destroy(); } catch (_) {}
    }
    if (session.conn) {
      try { session.conn.end(); } catch (_) {}
    }
    if (session.process) {
      try { session.process.kill(); } catch (_) {}
    }
    activeSessions.delete(socketId);
  }
}

module.exports = {
  registerSshTerminalHandlers,
  stopTerminalSession
};
