const { executeSshCommand } = require('../utils/sshExecutor');

const PM2_PATH_ENV = 'export PATH=$PATH:/usr/local/bin:/usr/bin:/bin:~/.nvm/versions/node/$(ls ~/.nvm/versions/node 2>/dev/null | tail -n 1)/bin;';

/**
 * List all PM2 applications on the server (pm2 jlist)
 */
async function listPm2Apps(server) {
  const cmd = 'pm2 jlist';
  try {
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000, envPrefix: PM2_PATH_ENV });
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
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 25000, envPrefix: PM2_PATH_ENV });
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
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 20000, envPrefix: PM2_PATH_ENV });
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
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 15000, envPrefix: PM2_PATH_ENV });
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
    const stdout = await executeSshCommand(server, cmd, { timeoutMs: 20000, envPrefix: PM2_PATH_ENV });
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
