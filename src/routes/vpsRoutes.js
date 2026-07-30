const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { getRemoteSSHMetrics } = require('../services/vpsMonitor');

// Health check endpoint for Docker & monitoring
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Get all registered VPS servers
router.get('/vps', async (req, res) => {
  try {
    const servers = await db.all('SELECT id, name, host, port, username, auth_type, is_local, type, pod_version, created_at FROM servers');

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
        currentMetrics: latestMetrics || {
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
        }
      };
    }));

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a new VPS / POD
router.post('/vps', async (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key, type, pod_version } = req.body;

    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Name and Host IP are required.' });
    }

    const serverType = (type === 'pod' || type === 'vps') ? type : 'vps';
    const podVer = serverType === 'pod' ? (pod_version || 'v3') : '';

    const result = await db.run(
      `INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local, type, pod_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        name,
        host,
        port || 22,
        username || 'root',
        auth_type || 'password',
        password || null,
        private_key || null,
        serverType,
        podVer
      ]
    );

    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update an existing VPS / POD
router.put('/vps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, port, username, auth_type, password, private_key, type, pod_version } = req.body;

    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Name and Host IP are required.' });
    }

    const serverType = (type === 'pod' || type === 'vps') ? type : 'vps';
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
        password = ?, private_key = ?, type = ?, pod_version = ?
       WHERE id = ?`,
      [
        name,
        host,
        port || 22,
        username || 'root',
        auth_type || 'password',
        finalPassword,
        finalPrivateKey,
        serverType,
        podVer,
        id
      ]
    );

    res.json({ success: true, message: 'Server VPS berhasil diperbarui.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Test SSH Connection
router.post('/vps/test-connection', async (req, res) => {
  try {
    const { host, port, username, auth_type, password, private_key } = req.body;
    const dummyServer = {
      id: 99999,
      host,
      port: port || 22,
      username: username || 'root',
      auth_type: auth_type || 'password',
      password,
      private_key
    };

    const metrics = await getRemoteSSHMetrics(dummyServer);
    if (metrics.status === 'offline') {
      return res.json({ success: false, message: 'Gagal terhubung ke VPS via SSH. Periksa IP, Port, dan Kredensial.' });
    }

    res.json({ success: true, message: 'Koneksi SSH berhasil!', metrics });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete a VPS
router.delete('/vps/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM servers WHERE id = ?', [id]);
    await db.run('DELETE FROM metrics_history WHERE server_id = ?', [id]);
    res.json({ success: true, message: 'VPS berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get historical metrics for a VPS (for charts)
router.get('/vps/:id/history', async (req, res) => {
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
});

module.exports = router;
