const dbAsync = require('../services/db');
const {
  listScreenApps,
  restartScreenApp,
  stopScreenApp,
  getScreenAppLogs
} = require('../services/screenAppService');

/**
 * Fetch status for Screen Apps (small-screen & big-screen)
 */
const getScreenApps = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const apps = await listScreenApps(server);
    res.json({ success: true, server_id: server.id, data: apps });
  } catch (err) {
    console.error(`Screen Apps List Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Restart a specific Screen App
 */
const restartApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { appName } = req.body;

    if (!appName) {
      return res.status(400).json({ success: false, error: 'Nama aplikasi (small-screen / big-screen) wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await restartScreenApp(server, appName);
    res.json({ success: true, message: `Aplikasi ${appName} berhasil dimuat ulang (restart).`, data: result });
  } catch (err) {
    console.error(`Screen App Restart Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Stop a specific Screen App
 */
const stopApp = async (req, res) => {
  try {
    const { id } = req.params;
    const { appName } = req.body;

    if (!appName) {
      return res.status(400).json({ success: false, error: 'Nama aplikasi (small-screen / big-screen) wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await stopScreenApp(server, appName);
    res.json({ success: true, message: `Aplikasi ${appName} berhasil dihentikan (stop).`, data: result });
  } catch (err) {
    console.error(`Screen App Stop Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Fetch logs for a specific Screen App
 */
const getAppLogs = async (req, res) => {
  try {
    const { id, appName } = req.params;

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await getScreenAppLogs(server, appName);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`Screen App Logs Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getScreenApps,
  restartApp,
  stopApp,
  getAppLogs
};
