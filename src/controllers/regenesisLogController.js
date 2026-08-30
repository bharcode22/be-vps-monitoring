const jwt = require('jsonwebtoken');
const dbAsync = require('../services/db');
const {
  listRegenesisLogs,
  readRegenesisLog,
  streamDownloadRegenesisLog,
  deleteRegenesisLog
} = require('../services/regenesisLogService');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Helper to fetch server record by ID
 */
async function getServerOrThrow(serverId) {
  if (!serverId) {
    throw new Error('ID Server harus disertakan.');
  }
  const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!server) {
    throw new Error('Server tidak ditemukan di database.');
  }
  return server;
}

/**
 * 1. GET /api/vps/:id/regenesis-logs
 * List all log files in /home/pod/Documents/RegenesisLogs
 */
async function getLogs(req, res) {
  try {
    const serverId = req.params.id || req.query.serverId;
    const server = await getServerOrThrow(serverId);

    const result = await listRegenesisLogs(server);
    res.json({
      success: true,
      serverId: server.id,
      serverName: server.name,
      ...result
    });
  } catch (err) {
    console.error('Error in getLogs controller:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 2. GET /api/vps/:id/regenesis-logs/content
 * Read contents of a specific log file with optional line limit & grep search
 */
async function getLogContent(req, res) {
  try {
    const serverId = req.params.id || req.query.serverId;
    const filename = req.query.file || req.query.filename;

    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file (?file=...) harus disertakan.' });
    }

    const server = await getServerOrThrow(serverId);
    const { lines, search, direction } = req.query;

    const data = await readRegenesisLog(server, filename, { lines, search, direction });
    res.json({
      success: true,
      data
    });
  } catch (err) {
    console.error('Error in getLogContent controller:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 3. GET /api/vps/:id/regenesis-logs/download
 * Stream download of log file directly to user's local disk
 */
async function downloadLogFile(req, res) {
  try {
    const serverId = req.params.id || req.query.serverId;
    const filename = req.query.file || req.query.filename;

    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file (?file=...) harus disertakan.' });
    }

    // Support token query parameter for browser direct download triggers
    const token = req.query.token || req.headers.authorization?.replace(/^Bearer\s+/, '');
    if (!req.user && token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
        if (!user || user.status !== 'approved') {
          return res.status(403).json({ success: false, error: 'Akses ditolak.' });
        }
      } catch (e) {
        return res.status(401).json({ success: false, error: 'Token autentikasi tidak valid.' });
      }
    } else if (!req.user && !token) {
      return res.status(401).json({ success: false, error: 'Autentikasi diperlukan.' });
    }

    const server = await getServerOrThrow(serverId);
    await streamDownloadRegenesisLog(server, filename, req, res);
  } catch (err) {
    console.error('Error in downloadLogFile controller:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

/**
 * 4. DELETE /api/vps/:id/regenesis-logs
 * Delete a specific log file from /home/pod/Documents/RegenesisLogs
 */
async function deleteLog(req, res) {
  try {
    const serverId = req.params.id || req.query.serverId;
    const filename = req.query.file || req.query.filename;

    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file (?file=...) harus disertakan.' });
    }

    const server = await getServerOrThrow(serverId);
    const result = await deleteRegenesisLog(server, filename);

    res.json({
      success: true,
      message: `File ${filename} berhasil dihapus dari server.`,
      data: result
    });
  } catch (err) {
    console.error('Error in deleteLog controller:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getLogs,
  getLogContent,
  downloadLogFile,
  deleteLog
};
