const dbAsync = require('../services/db');
const { listPm2Apps, restartPm2App, stopPm2App, deletePm2App, getPm2AppLogs } = require('../services/pm2Service');

/**
 * Fetch all PM2 applications for a specific server
 */
const getApps = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const apps = await listPm2Apps(server);
    res.json({ success: true, server_id: server.id, data: apps });
  } catch (err) {
    console.error(`PM2 List Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Restart a specific PM2 app
 */
const restartApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { appName } = req.body;

    if (!appName) {
      return res.status(400).json({ success: false, error: 'Nama/ID aplikasi PM2 wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await restartPm2App(server, appName);
    res.json({ success: true, message: `Aplikasi PM2 ${appName} berhasil dimuat ulang (restart).`, data: result });
  } catch (err) {
    console.error(`PM2 Restart Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Stop a specific PM2 app
 */
const stopApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { appName } = req.body;

    if (!appName) {
      return res.status(400).json({ success: false, error: 'Nama/ID aplikasi PM2 wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await stopPm2App(server, appName);
    res.json({ success: true, message: `Aplikasi PM2 ${appName} berhasil dihentikan (stop).`, data: result });
  } catch (err) {
    console.error(`PM2 Stop Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete a specific PM2 app (pm2 delete)
 */
const deleteApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { appName } = req.body;

    if (!appName) {
      return res.status(400).json({ success: false, error: 'Nama/ID aplikasi PM2 wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await deletePm2App(server, appName);
    res.json({ success: true, message: `Aplikasi PM2 ${appName} berhasil dihapus (pm2 delete).`, data: result });
  } catch (err) {
    console.error(`PM2 Delete Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Fetch logs for a specific PM2 app
 */
const getAppLogs = async (req, res) => {
  try {
    const { id, appName } = req.params;

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await getPm2AppLogs(server, appName);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`PM2 Logs Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getApps,
  restartApp,
  stopApp,
  deleteApp,
  getAppLogs
};
