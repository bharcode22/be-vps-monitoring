const db = require('../services/db');
const { getRemoteSSHMetrics, collectAllServerMetrics } = require('../services/vpsMonitor');

// Fallback metrics object when a server has no historical data yet
const DEFAULT_FALLBACK_METRICS = {
  cpu_usage: 0,
  cpu_cores: 1,
  ram_usage: 0,
  ram_used_mb: 0,
  ram_free_mb: 0,
  ram_total_mb: 0,
  bandwidth_rx_speed: 0,
  bandwidth_tx_speed: 0,
  disk_usage: 0,
  disk_used_gb: 0,
  disk_total_gb: 0,
  disk_free_gb: 0,
  gpu_usage: 0,
  gpu_memory_usage: 0,
  gpu_name: 'N/A',
  gpu_temp: 0,
  ping_ms: 0,
  status: 'unknown'
};

/**
 * Health check endpoint controller
 */
const getHealth = (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
};

/**
 * Get all registered VPS / POD servers with their latest metrics
 */
const getAllServers = async (req, res) => {
  try {
    const search = req.query.q || req.query.search || '';
    let query = 'SELECT id, name, host, port, username, auth_type, is_local, type, pod_version, created_at FROM servers';
    let params = [];

    if (search.trim()) {
      const term = `%${search.trim()}%`;
      query += ' WHERE name LIKE ? OR host LIKE ? OR username LIKE ? OR type LIKE ? OR pod_version LIKE ?';
      params = [term, term, term, term, term];
    }

    const servers = await db.all(query, params);

    // Fetch latest metrics for each server
    const result = await Promise.all(servers.map(async (server) => {
      const latestMetrics = await db.get(
        'SELECT * FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1',
        [server.id]
      );

      return {
        ...server,
        type: server.type || 'vps',
        pod_version: server.pod_version || '',
        currentMetrics: latestMetrics || DEFAULT_FALLBACK_METRICS
      };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add Standar VPS Server
 */
const createVps = async (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama Server dan Host IP wajib diisi.' });
    }
    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version, db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'vps', '', '', '', '', '', '', '', '')`,
      [name, host, port || 22, username || 'root', auth_type || 'password', password || null, private_key || null]
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add POD Container Server
 */
const createPod = async (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key, pod_version } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama POD dan Host IP wajib diisi.' });
    }
    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version, db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pod', ?, '', '', '', '', '', '', '')`,
      [name, host, port || 22, username || 'pod', auth_type || 'password', password || null, private_key || null, pod_version || 'v3']
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add PostgreSQL Database
 */
const createDatabase = async (req, res) => {
  try {
    const { name, host, port, db_name, db_user, password } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama Database dan Host IP wajib diisi.' });
    }
    const finalDbUser = db_user || 'postgres';
    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version, db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket)
       VALUES (?, ?, ?, ?, 'password', ?, NULL, 0, 'postgresql', '', ?, ?, '', '', '', '', '')`,
      [name, host, port || 5432, finalDbUser, password || '', db_name || 'postgres', finalDbUser]
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add Object Storage (MinIO or AWS S3)
 */
const createStorage = async (req, res) => {
  try {
    const { name, type, host, port, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket } = req.body;
    const storageType = (type === 's3') ? 's3' : 'minio';
    const targetEndpoint = s3_endpoint || host || (storageType === 's3' ? 's3.amazonaws.com' : '');

    if (!name || !targetEndpoint) {
      return res.status(400).json({ success: false, error: 'Nama Storage dan Endpoint URL wajib diisi.' });
    }

    const accessKey = s3_access_key || '';
    const secretKey = s3_secret_key || '';

    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version, db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket)
       VALUES (?, ?, ?, ?, 'key', ?, NULL, 0, ?, '', '', '', ?, ?, ?, ?, ?)`,
      [
        name,
        targetEndpoint,
        port || (storageType === 'minio' ? 9000 : 443),
        accessKey, // username set to accessKey (NOT postgres!)
        secretKey,
        storageType,
        targetEndpoint,
        accessKey,
        secretKey,
        s3_region || 'us-east-1',
        s3_bucket || ''
      ]
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * General createServer Dispatcher
 */
const createServer = async (req, res) => {
  const { type } = req.body;
  if (type === 'vps') return createVps(req, res);
  if (type === 'pod') return createPod(req, res);
  if (type === 'postgresql') return createDatabase(req, res);
  if (type === 'minio' || type === 's3') return createStorage(req, res);
  return createVps(req, res);
};

/**
 * Update an existing VPS / POD / Postgres / Storage server configuration
 */
const updateServer = async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name, host, port, username, auth_type, password, private_key, type, pod_version,
      db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket
    } = req.body;

    const serverType = ['vps', 'pod', 'postgresql', 'minio', 's3'].includes(type) ? type : 'vps';
    const targetHost = host || s3_endpoint || (serverType === 's3' ? 's3.amazonaws.com' : '');

    if (!name || !targetHost) {
      return res.status(400).json({ success: false, error: 'Nama Layanan dan Host IP / Endpoint wajib diisi.' });
    }

    const podVer = serverType === 'pod' ? (pod_version || 'v3') : '';

    // Fetch existing server to preserve password/key if not explicitly changed
    const existing = await db.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan.' });
    }

    const finalPassword = (password && password !== '******') ? password : existing.password;
    const finalPrivateKey = (private_key && private_key !== '******') ? private_key : existing.private_key;

    await db.run(
      `UPDATE servers SET
        name = ?, host = ?, port = ?, username = ?, auth_type = ?,
        password = ?, private_key = ?, type = ?, pod_version = ?,
        db_name = ?, db_user = ?, s3_endpoint = ?, s3_access_key = ?, s3_secret_key = ?, s3_region = ?, s3_bucket = ?
       WHERE id = ?`,
      [
        name,
        targetHost,
        port || (serverType === 'postgresql' ? 5432 : (serverType === 'minio' ? 9000 : 22)),
        username || 'root',
        auth_type || 'password',
        finalPassword,
        finalPrivateKey,
        serverType,
        podVer,
        db_name || '',
        db_user || '',
        s3_endpoint || '',
        s3_access_key || '',
        s3_secret_key || '',
        s3_region || 'us-east-1',
        s3_bucket || '',
        id
      ]
    );

    // Trigger instant WebSocket broadcast to all connected dashboards
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);

    res.json({ success: true, message: 'Data konfigurasi berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete a server and its metrics history
 */
const deleteServer = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);

    // Trigger instant WebSocket broadcast to all connected dashboards
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);

    res.json({ success: true, message: 'VPS berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Test Connection before saving
 */
const testConnection = async (req, res) => {
  try {
    const {
      host, port, username, auth_type, password, private_key, type,
      db_name, db_user, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket
    } = req.body;

    const dummyServer = {
      id: 99999,
      host,
      port: port || (type === 'postgresql' ? 5432 : 22),
      username: username || 'root',
      auth_type: auth_type || 'password',
      password,
      private_key,
      type,
      db_name,
      db_user,
      s3_endpoint,
      s3_access_key,
      s3_secret_key,
      s3_region,
      s3_bucket
    };

    const { getPostgresMetrics } = require('../services/monitor/dbCollector');
    const { getS3Metrics } = require('../services/monitor/s3Collector');

    let metrics;
    if (type === 'postgresql') {
      metrics = await getPostgresMetrics(dummyServer);
    } else if (type === 'minio' || type === 's3') {
      metrics = await getS3Metrics(dummyServer);
    } else {
      metrics = await getRemoteSSHMetrics(dummyServer);
    }

    if (metrics.status === 'offline') {
      return res.json({
        success: false,
        message: metrics.error || 'Gagal terhubung ke layanan infrastruktur. Periksa Host, Port, dan Kredensial.'
      });
    }

    res.json({ success: true, message: 'Koneksi ke layanan berhasil terverifikasi!', metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Get historical metrics for chart plotting
 */
const getServerHistory = async (req, res) => {
  try {
    const { id } = req.params;
    const history = await db.all(
      `SELECT cpu_usage, ram_usage, ram_used_mb, ram_total_mb, bandwidth_rx_speed, bandwidth_tx_speed, disk_usage, gpu_usage, gpu_memory_usage, gpu_temp, ping_ms, timestamp
       FROM metrics_history
       WHERE server_id = ?
       ORDER BY timestamp DESC
       LIMIT 60`,
      [id]
    );

    res.json({ success: true, data: history.reverse() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Get all user settings (e.g. tv_mode)
 */
const getSettings = async (req, res) => {
  try {
    const rows = await db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => {
      settings[r.key] = r.value;
    });
    res.json({ success: true, data: settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Save / Update a user setting
 */
const saveSetting = async (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ success: false, error: 'Setting key is required' });

    await db.run(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, String(value)]
    );

    res.json({ success: true, message: 'Setting saved successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getHealth,
  getAllServers,
  createServer,
  createVps,
  createPod,
  createDatabase,
  createStorage,
  updateServer,
  deleteServer,
  testConnection,
  getServerHistory,
  getSettings,
  saveSetting
};
