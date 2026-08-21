const { exec } = require('child_process');
const { Client } = require('ssh2');
const { decrypt } = require('../utils/crypto');

const ALLOWED_SCRIPTS = ['auto-script.sh', 'kill-process.sh'];
const SCRIPT_DIR = '/home/pod/scripts/exec';

/**
 * Execute bash script inside /home/pod/scripts/exec/ on local host or remote SSH server
 */
async function runVpsScript(server, scriptName) {
  if (!ALLOWED_SCRIPTS.includes(scriptName)) {
    throw new Error(`Skrip ${scriptName} tidak diizinkan untuk dieksekusi. Hanya auto-script.sh dan kill-process.sh yang diizinkan.`);
  }

  const scriptPath = `${SCRIPT_DIR}/${scriptName}`;
  const command = `cd ${SCRIPT_DIR} && (sed -i 's/\\r$//' ${scriptName} 2>/dev/null || true); (chmod +x ${scriptName} 2>/dev/null || true); (bash ./${scriptName} || sh ./${scriptName} || ./${scriptName}) 2>&1`;

  return new Promise((resolve, reject) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
        if (error && !stdout && !stderr) {
          return reject(new Error(`Gagal mengeksekusi skrip lokal: ${error.message}`));
        }
        resolve({
          success: true,
          output: stdout || stderr || 'Skrip selesai tanpa output.'
        });
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          reject(new Error('Koneksi SSH waktu habis saat mengeksekusi skrip (timeout 30 detik).'));
        }
      }, 30000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'root',
        readyTimeout: 10000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = decrypt(server.private_key);
      } else {
        sshConfig.password = decrypt(server.password);
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code, signal) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve({
                success: true,
                script: scriptName,
                path: scriptPath,
                output: stdout || '',
                stderr: stderr || '',
                exitCode: code
              });
            }
          }).on('data', (data) => {
            stdout += data.toString();
          }).stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      });

      conn.on('error', (err) => {
        if (!isHandled) {
          isHandled = true;
          clearTimeout(timeout);
          reject(new Error(`Gagal menghubungkan SSH: ${err.message}`));
        }
      });

      conn.connect(sshConfig);
    }
  });
}

module.exports = {
  runVpsScript,
  ALLOWED_SCRIPTS
};
