const { exec } = require('child_process');
const { Client } = require('ssh2');
const { decrypt } = require('../utils/crypto');

const PM2_PATH_ENV = 'export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin;';

/**
 * Execute command on local host or remote SSH server
 */
function executeCommand(server, command) {
  return new Promise((resolve, reject) => {
    const fullCmd = `${PM2_PATH_ENV} ${command}`;

    if (server.is_local === 1) {
      exec(fullCmd, { timeout: 15000 }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout);
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          reject(new Error('Koneksi SSH ke server waktu habis (timeout 15 detik)'));
        }
      }, 15000);

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
        conn.exec(fullCmd, (err, stream) => {
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
              if (code !== 0 && stderr.trim() && !stdout.trim()) {
                return reject(new Error(stderr.trim()));
              }
              resolve(stdout);
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

/**
 * List all PM2 applications on the server (pm2 jlist)
 */
async function listPm2Apps(server) {
  const cmd = 'pm2 jlist';
  try {
    const stdout = await executeCommand(server, cmd);
    let parsed = [];
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (e) {
      // Try finding JSON array if there's extra terminal output
      const jsonStart = stdout.indexOf('[');
      const jsonEnd = stdout.lastIndexOf(']');
      if (jsonStart !== -1 && jsonEnd !== -1) {
        parsed = JSON.parse(stdout.substring(jsonStart, jsonEnd + 1));
      }
    }

    if (!Array.isArray(parsed)) return [];

    return parsed.map(app => ({
      id: app.pm_id,
      name: app.name,
      status: app.pm2_env?.status || 'unknown',
      restarts: app.pm2_env?.restart_time || 0,
      uptime: app.pm2_env?.pm_uptime || 0,
      memory: app.monit?.memory || 0,
      cpu: app.monit?.cpu || 0,
      mode: app.pm2_env?.exec_mode || 'fork_mode',
      node_version: app.pm2_env?.node_version || '',
      script: app.pm2_env?.pm_exec_path || ''
    }));
  } catch (err) {
    throw new Error(`Gagal mengeksekusi pm2 jlist: ${err.message}`);
  }
}

/**
 * Restart a PM2 app by name or ID
 */
async function restartPm2App(server, appName) {
  const safeName = String(appName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama/ID aplikasi PM2 tidak valid.');

  const cmd = `pm2 restart ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, app: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal memuat ulang (restart) aplikasi PM2 ${safeName}: ${err.message}`);
  }
}

/**
 * Stop a PM2 app by name or ID
 */
async function stopPm2App(server, appName) {
  const safeName = String(appName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama/ID aplikasi PM2 tidak valid.');

  const cmd = `pm2 stop ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, app: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghentikan (stop) aplikasi PM2 ${safeName}: ${err.message}`);
  }
}

/**
 * Fetch last 100 lines of PM2 app logs
 */
async function getPm2AppLogs(server, appName) {
  const safeName = String(appName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama/ID aplikasi PM2 tidak valid.');

  const cmd = `pm2 logs ${safeName} --lines 100 --nostream --raw 2>&1`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, app: safeName, logs: stdout };
  } catch (err) {
    throw new Error(`Gagal mengambil log PM2 ${safeName}: ${err.message}`);
  }
}

/**
 * Delete a PM2 app by name or ID (pm2 delete)
 */
async function deletePm2App(server, appName) {
  const safeName = String(appName).replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safeName) throw new Error('Nama/ID aplikasi PM2 tidak valid.');

  const cmd = `pm2 delete ${safeName}`;
  try {
    const stdout = await executeCommand(server, cmd);
    return { success: true, app: safeName, output: stdout.trim() };
  } catch (err) {
    throw new Error(`Gagal menghapus (delete) aplikasi PM2 ${safeName}: ${err.message}`);
  }
}

module.exports = {
  listPm2Apps,
  restartPm2App,
  stopPm2App,
  deletePm2App,
  getPm2AppLogs
};
