const { Client } = require('ssh2');
const { exec } = require('child_process');

/**
 * Execute command on SSH remote server or local host
 */
function executeSSHCommand(server, command) {
  return new Promise((resolve) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          return resolve({ success: false, stdout, stderr: stderr.trim() || error.message });
        }
        resolve({ success: true, stdout, stderr });
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          resolve({ success: false, stdout: '', stderr: 'Koneksi SSH ke server waktu habis (timeout 5 menit)' });
        }
      }, 300000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'pod',
        readyTimeout: 15000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return resolve({ success: false, stdout: '', stderr: err.message });
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data) => {
            stdout += data.toString();
          });
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          stream.on('close', (code) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve({
                success: code === 0,
                code,
                stdout,
                stderr
              });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!isHandled) {
          isHandled = true;
          resolve({ success: false, stdout: '', stderr: `Error koneksi SSH: ${err.message}` });
        }
      });

      conn.connect(sshConfig);
    }
  });
}

/**
 * Execute SSH command and stream stdout/stderr chunks in real-time
 */
function executeSSHCommandStream(server, command, onData) {
  return new Promise((resolve) => {
    if (server.is_local === 1) {
      const child = exec(command, { timeout: 600000 });
      let stdout = '';
      let stderr = '';
      if (child.stdout) {
        child.stdout.on('data', data => {
          const str = data.toString();
          stdout += str;
          if (onData) onData(str);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', data => {
          const str = data.toString();
          stderr += str;
          if (onData) onData(str);
        });
      }
      child.on('close', code => {
        resolve({ success: code === 0, code, stdout, stderr });
      });
      child.on('error', err => {
        resolve({ success: false, stdout, stderr: err.message });
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          if (onData) onData('\n❌ Koneksi SSH waktu habis (timeout 10 menit)\n');
          resolve({ success: false, stdout: '', stderr: 'Timeout 10 menit' });
        }
      }, 600000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'pod',
        readyTimeout: 30000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            if (onData) onData(`\n❌ Error exec SSH: ${err.message}\n`);
            return resolve({ success: false, stdout: '', stderr: err.message });
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data) => {
            const str = data.toString();
            stdout += str;
            if (onData) onData(str);
          });
          stream.stderr.on('data', (data) => {
            const str = data.toString();
            stderr += str;
            if (onData) onData(str);
          });

          stream.on('close', (code) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve({
                success: code === 0,
                code,
                stdout,
                stderr
              });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!isHandled) {
          isHandled = true;
          if (onData) onData(`\n❌ SSH Connection Error: ${err.message}\n`);
          resolve({ success: false, stdout: '', stderr: `Error koneksi SSH: ${err.message}` });
        }
      });

      conn.connect(sshConfig);
    }
  });
}

module.exports = {
  executeSSHCommand,
  executeSSHCommandStream
};
