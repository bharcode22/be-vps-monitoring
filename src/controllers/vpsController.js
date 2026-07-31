const db = require('../services/db');
const { getRemoteSSHMetrics } = require('../services/monitor/sshCollector');
const { collectAllServerMetrics } = require('../services/vpsMonitor');

// Default fallback metrics structure for clean UI rendering when offline or initializing
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
  gpu_name: '',
  gpu_temp: 0,
  ping_ms: 0,
  status: 'offline'
};

/**
 * Health check handler
 */
const getHealth = (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
};

/**
 * Get all registered VPS, POD, PostgreSQL, and Storage services across their dedicated tables
 */
const getAllServers = async (req, res) => {
  try {
    const search = (req.query.q || req.query.search || '').trim();
    const term = `%${search}%`;

    // 1. Fetch SSH Servers (servers table)
    let vpsQuery = 'SELECT id, name, host, port, username, auth_type, is_local, type, pod_version, created_at FROM servers';
    let vpsParams = [];
    if (search) {
      vpsQuery += ' WHERE name LIKE ? OR host LIKE ? OR username LIKE ? OR type LIKE ? OR pod_version LIKE ?';
      vpsParams = [term, term, term, term, term];
    }
    const sshServers = await db.all(vpsQuery, vpsParams);

    // 2. Fetch PostgreSQL Databases (databases_postgres table)
    let dbQuery = 'SELECT id, name, host, port, db_name, db_user, password, created_at FROM databases_postgres';
    let dbParams = [];
    if (search) {
      dbQuery += ' WHERE name LIKE ? OR host LIKE ? OR db_name LIKE ? OR db_user LIKE ?';
      dbParams = [term, term, term, term];
    }
    const dbRows = await db.all(dbQuery, dbParams);
    const dbServers = dbRows.map(r => ({
      ...r,
      type: 'postgresql',
      username: r.db_user,
      password: r.password ? '******' : ''
    }));

    // 3. Fetch Object Storage Services (object_storages table)
    let storageQuery = 'SELECT id, name, type, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket, port, created_at FROM object_storages';
    let storageParams = [];
    if (search) {
      storageQuery += ' WHERE name LIKE ? OR s3_endpoint LIKE ? OR s3_bucket LIKE ? OR type LIKE ?';
      storageParams = [term, term, term, term];
    }
    const storageRows = await db.all(storageQuery, storageParams);
    const storageServers = storageRows.map(r => ({
      ...r,
      host: r.s3_endpoint || 's3.amazonaws.com',
      username: r.s3_access_key,
      password: r.s3_secret_key ? '******' : ''
    }));

    const allItems = [...sshServers, ...dbServers, ...storageServers];

    // Fetch latest metrics for each server item
    const result = await Promise.all(allItems.map(async (server) => {
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
 * GET Standar VPS Servers
 */
const getVpsServers = async (req, res) => {
  try {
    const search = (req.query.q || req.query.search || '').trim();
    let query = "SELECT id, name, host, port, username, auth_type, is_local, type, pod_version, created_at FROM servers WHERE (type = 'vps' OR type IS NULL OR type = '')";
    let params = [];

    if (search) {
      query += ' AND (name LIKE ? OR host LIKE ? OR username LIKE ?)';
      const term = `%${search}%`;
      params = [term, term, term];
    }

    const sshServers = await db.all(query, params);
    const result = await Promise.all(sshServers.map(async (server) => {
      const latestMetrics = await db.get('SELECT * FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1', [server.id]);
      return { ...server, type: 'vps', currentMetrics: latestMetrics || DEFAULT_FALLBACK_METRICS };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET POD Container Servers
 */
const getPodServers = async (req, res) => {
  try {
    const search = (req.query.q || req.query.search || '').trim();
    let query = "SELECT id, name, host, port, username, auth_type, is_local, type, pod_version, created_at FROM servers WHERE type = 'pod'";
    let params = [];

    if (search) {
      query += ' AND (name LIKE ? OR host LIKE ? OR username LIKE ? OR pod_version LIKE ?)';
      const term = `%${search}%`;
      params = [term, term, term, term];
    }

    const podServers = await db.all(query, params);
    const result = await Promise.all(podServers.map(async (server) => {
      const latestMetrics = await db.get('SELECT * FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1', [server.id]);
      return { ...server, type: 'pod', currentMetrics: latestMetrics || DEFAULT_FALLBACK_METRICS };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET PostgreSQL Databases
 */
const getDatabaseServers = async (req, res) => {
  try {
    const search = (req.query.q || req.query.search || '').trim();
    let query = 'SELECT id, name, host, port, db_name, db_user, password, created_at FROM databases_postgres';
    let params = [];

    if (search) {
      query += ' WHERE name LIKE ? OR host LIKE ? OR db_name LIKE ? OR db_user LIKE ?';
      const term = `%${search}%`;
      params = [term, term, term, term];
    }

    const dbRows = await db.all(query, params);
    const result = await Promise.all(dbRows.map(async (server) => {
      const latestMetrics = await db.get('SELECT * FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1', [server.id]);
      return {
        ...server,
        type: 'postgresql',
        username: server.db_user,
        password: server.password ? '******' : '',
        currentMetrics: latestMetrics || DEFAULT_FALLBACK_METRICS
      };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET Object Storage Services (MinIO & AWS S3)
 */
const getStorageServers = async (req, res) => {
  try {
    const search = (req.query.q || req.query.search || '').trim();
    let query = 'SELECT id, name, type, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket, port, created_at FROM object_storages';
    let params = [];

    if (search) {
      query += ' WHERE name LIKE ? OR s3_endpoint LIKE ? OR s3_bucket LIKE ? OR type LIKE ?';
      const term = `%${search}%`;
      params = [term, term, term, term];
    }

    const storageRows = await db.all(query, params);
    const result = await Promise.all(storageRows.map(async (server) => {
      const latestMetrics = await db.get('SELECT * FROM metrics_history WHERE server_id = ? ORDER BY timestamp DESC LIMIT 1', [server.id]);
      return {
        ...server,
        host: server.s3_endpoint || 's3.amazonaws.com',
        username: server.s3_access_key,
        password: server.s3_secret_key ? '******' : '',
        currentMetrics: latestMetrics || DEFAULT_FALLBACK_METRICS
      };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add Standar VPS Server into `servers` table
 */
const createVps = async (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama Server dan Host IP wajib diisi.' });
    }
    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'vps', '')`,
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
 * Update Standar VPS Server (Table: servers)
 */
const updateVps = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, port, username, auth_type, password, private_key } = req.body;
    const existing = await db.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'Server VPS tidak ditemukan.' });

    const finalPassword = (password && password !== '******') ? password : existing.password;
    const finalPrivateKey = (private_key && private_key !== '******') ? private_key : existing.private_key;

    await db.run(
      `UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, password = ?, private_key = ? WHERE id = ?`,
      [name, host, port || 22, username || 'root', auth_type || 'password', finalPassword, finalPrivateKey, id]
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'Server VPS berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete VPS Server (Table: servers)
 */
const deleteVps = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'Server VPS berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add POD Container Server into `servers` table
 */
const createPod = async (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key, pod_version } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama POD dan Host IP wajib diisi.' });
    }
    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'pod', ?)`,
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
 * Update POD Container Server (Table: servers)
 */
const updatePod = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, port, username, auth_type, password, private_key, pod_version } = req.body;
    const existing = await db.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!existing) return res.status(404).json({ success: false, error: 'POD Server tidak ditemukan.' });

    const finalPassword = (password && password !== '******') ? password : existing.password;
    const finalPrivateKey = (private_key && private_key !== '******') ? private_key : existing.private_key;

    await db.run(
      `UPDATE servers SET name = ?, host = ?, port = ?, username = ?, auth_type = ?, password = ?, private_key = ?, pod_version = ? WHERE id = ?`,
      [name, host, port || 22, username || 'pod', auth_type || 'password', finalPassword, finalPrivateKey, pod_version || 'v3', id]
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'POD Container berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete POD Server (Table: servers)
 */
const deletePod = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'POD Container berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add PostgreSQL Database into dedicated `databases_postgres` table
 */
const createDatabase = async (req, res) => {
  try {
    const { name, host, port, db_name, db_user, password } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Nama Database dan Host IP wajib diisi.' });
    }
    const finalDbUser = db_user || 'postgres';
    const result = await db.run(
      `INSERT INTO databases_postgres (name, host, port, db_name, db_user, password)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [name, host, port || 5432, db_name || 'postgres', finalDbUser, password || '']
    );
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Update PostgreSQL Database (Table: databases_postgres or fallback servers)
 */
const updateDatabase = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, port, db_name, db_user, password } = req.body;
    let existing = await db.get('SELECT * FROM databases_postgres WHERE id = ?', [id]);
    if (existing) {
      const finalPassword = (password && password !== '******') ? password : existing.password;
      await db.run(
        `UPDATE databases_postgres SET name = ?, host = ?, port = ?, db_name = ?, db_user = ?, password = ? WHERE id = ?`,
        [name, host, port || 5432, db_name || 'postgres', db_user || 'postgres', finalPassword, id]
      );
      const io = req.app.get('io');
      if (io) collectAllServerMetrics(io);
      return res.json({ success: true, message: 'Database PostgreSQL berhasil diperbarui.' });
    }

    // Fallback: Check legacy servers table
    existing = await db.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (existing) {
      const finalPassword = (password && password !== '******') ? password : existing.password;
      await db.run(
        `UPDATE servers SET name = ?, host = ?, port = ?, db_name = ?, db_user = ?, password = ? WHERE id = ?`,
        [name, host, port || 5432, db_name || 'postgres', db_user || 'postgres', finalPassword, id]
      );
      const io = req.app.get('io');
      if (io) collectAllServerMetrics(io);
      return res.json({ success: true, message: 'Database PostgreSQL berhasil diperbarui.' });
    }

    return res.status(404).json({ success: false, error: 'Database PostgreSQL tidak ditemukan.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete PostgreSQL Database (Table: databases_postgres)
 */
const deleteDatabase = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM databases_postgres WHERE id = ?', [id]);
    await db.run('DELETE FROM servers WHERE id = ? AND type = "postgresql"', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'Database PostgreSQL berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add Object Storage (MinIO or AWS S3) into dedicated `object_storages` table
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
      `INSERT INTO object_storages (name, type, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket, port)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        storageType,
        targetEndpoint,
        accessKey,
        secretKey,
        s3_region || 'us-east-1',
        s3_bucket || '',
        port || (storageType === 'minio' ? 9000 : 443)
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
 * Update Object Storage (Table: object_storages or fallback servers)
 */
const updateStorage = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, type, host, port, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket } = req.body;
    const storageType = (type === 's3') ? 's3' : 'minio';

    let existing = await db.get('SELECT * FROM object_storages WHERE id = ?', [id]);
    if (existing) {
      const finalSecretKey = (s3_secret_key && s3_secret_key !== '******') ? s3_secret_key : existing.s3_secret_key;
      await db.run(
        `UPDATE object_storages SET name = ?, type = ?, s3_endpoint = ?, s3_access_key = ?, s3_secret_key = ?, s3_region = ?, s3_bucket = ?, port = ? WHERE id = ?`,
        [name, storageType, s3_endpoint || host, s3_access_key, finalSecretKey, s3_region || 'us-east-1', s3_bucket || '', port || (storageType === 'minio' ? 9000 : 443), id]
      );
      const io = req.app.get('io');
      if (io) collectAllServerMetrics(io);
      return res.json({ success: true, message: 'Object Storage berhasil diperbarui.' });
    }

    // Fallback: Check legacy servers table
    existing = await db.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (existing) {
      const finalSecretKey = (s3_secret_key && s3_secret_key !== '******') ? s3_secret_key : existing.s3_secret_key;
      await db.run(
        `UPDATE servers SET name = ?, type = ?, s3_endpoint = ?, s3_access_key = ?, s3_secret_key = ?, s3_region = ?, s3_bucket = ?, port = ? WHERE id = ?`,
        [name, storageType, s3_endpoint || host, s3_access_key, finalSecretKey, s3_region || 'us-east-1', s3_bucket || '', port || (storageType === 'minio' ? 9000 : 443), id]
      );
      const io = req.app.get('io');
      if (io) collectAllServerMetrics(io);
      return res.json({ success: true, message: 'Object Storage berhasil diperbarui.' });
    }

    return res.status(404).json({ success: false, error: 'Object Storage tidak ditemukan.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete Object Storage (Table: object_storages)
 */
const deleteStorage = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM object_storages WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);
    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);
    res.json({ success: true, message: 'Object Storage berhasil dihapus.' });
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
 * Update an existing VPS / POD / Postgres / Storage server configuration across dedicated tables
 */
const updateServer = async (req, res) => {
  try {
    const { id } = req.params;
    const { type } = req.body;

    if (type === 'postgresql') return updateDatabase(req, res);
    if (type === 'minio' || type === 's3') return updateStorage(req, res);
    if (type === 'pod') return updatePod(req, res);
    return updateVps(req, res);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete a server or service across dedicated tables and remove its metrics history
 */
const deleteServer = async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM databases_postgres WHERE id = ?', [id]);
    await db.run('DELETE FROM object_storages WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);

    const io = req.app.get('io');
    if (io) collectAllServerMetrics(io);

    res.json({ success: true, message: 'Layanan berhasil dihapus.' });
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
      auth_type,
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
  getVpsServers,
  getPodServers,
  getDatabaseServers,
  getStorageServers,
  createServer,
  createVps,
  updateVps,
  deleteVps,
  createPod,
  updatePod,
  deletePod,
  createDatabase,
  updateDatabase,
  deleteDatabase,
  createStorage,
  updateStorage,
  deleteStorage,
  updateServer,
  deleteServer,
  testConnection,
  getServerHistory,
  getSettings,
  saveSetting
};
