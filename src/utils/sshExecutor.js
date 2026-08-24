const { exec } = require('child_process');
const { Client } = require('ssh2');
const { decrypt } = require('./crypto');

/**
 * Execute command on local server or remote SSH host with robust connection management,
 * proper resource cleanup, and timeout handling.
 *
 * @param {Object} server - Server record from database
 * @param {string} command - Shell command to execute
 * @param {Object} options - Configuration options
 * @param {number} [options.timeoutMs=15000] - Execution timeout in milliseconds
 * @param {number} [options.readyTimeoutMs=10000] - SSH handshake timeout in milliseconds
 * @param {string} [options.envPrefix=''] - Optional shell environment prefix (e.g. export PATH=...)
 * @returns {Promise<string>} stdout output
 */
function executeSshCommand(server, command, options = {}) {
  const timeoutMs = options.timeoutMs || 15000;
  const readyTimeoutMs = options.readyTimeoutMs || 10000;
  const envPrefix = options.envPrefix || '';
  const fullCommand = envPrefix ? `${envPrefix} ${command}` : command;

  return new Promise((resolve, reject) => {
    if (!server) {
      return reject(new Error('Konfigurasi server tidak valid (server null/undefined)'));
    }

    // 1. Local execution
    if (server.is_local === 1) {
      exec(fullCommand, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout || '');
      });
      return;
    }

    // 2. Remote SSH execution
    const conn = new Client();
    let isHandled = false;
    let activeStream = null;

    const timeoutSec = Math.round(timeoutMs / 1000);
    const timeout = setTimeout(() => {
      if (!isHandled) {
        isHandled = true;
        cleanupResources();
        reject(new Error(`Koneksi SSH ke server waktu habis (timeout ${timeoutSec} detik)`));
      }
    }, timeoutMs);

    function cleanupResources() {
      clearTimeout(timeout);
      if (activeStream) {
        try { activeStream.destroy(); } catch (_) {}
      }
      try { conn.end(); } catch (_) {}
    }

    let privateKey = null;
    let password = null;

    try {
      if (server.auth_type === 'key' && server.private_key) {
        privateKey = decrypt(server.private_key);
      } else if (server.password) {
        password = decrypt(server.password);
      }
    } catch (decryptErr) {
      clearTimeout(timeout);
      return reject(new Error(`Gagal mendekripsi kredensial SSH: ${decryptErr.message}`));
    }

    const sshConfig = {
      host: server.host,
      port: server.port || 22,
      username: server.username || 'root',
      readyTimeout: readyTimeoutMs
    };

    if (privateKey) {
      sshConfig.privateKey = privateKey;
    } else {
      sshConfig.password = password;
    }

    conn.on('ready', () => {
      conn.exec(fullCommand, (err, stream) => {
        if (err) {
          if (!isHandled) {
            isHandled = true;
            cleanupResources();
            return reject(err);
          }
          return;
        }

        activeStream = stream;
        let stdout = '';
        let stderr = '';

        stream.on('close', (code, signal) => {
          if (!isHandled) {
            isHandled = true;
            cleanupResources();
            if (code !== 0 && !stdout.trim() && stderr.trim()) {
              return reject(new Error(stderr.trim()));
            }
            resolve(stdout || '');
          }
        });

        stream.on('data', (data) => {
          stdout += data.toString();
        });

        stream.stderr.on('data', (data) => {
          stderr += data.toString();
        });
      });
    });

    conn.on('error', (err) => {
      if (!isHandled) {
        isHandled = true;
        cleanupResources();
        reject(new Error(`Gagal menghubungkan SSH (${server.host}): ${err.message}`));
      }
    });

    try {
      conn.connect(sshConfig);
    } catch (connErr) {
      if (!isHandled) {
        isHandled = true;
        cleanupResources();
        reject(new Error(`Kesalahan inisialisasi koneksi SSH: ${connErr.message}`));
      }
    }
  });
}

module.exports = {
  executeSshCommand
};
