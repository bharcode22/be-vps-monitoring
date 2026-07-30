const express = require('express');
const router = express.Router();
const db = require('../services/db');
const { getRemoteSSHMetrics } = require('../services/vpsMonitor');

// Health check endpoint for Docker & monitoring
router.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date() });
});

// Get all registered VPS servers
router.get('/vps', (req, res) => {
  try {
    const servers = db.prepare('SELECT id, name, host, port, username, auth_type, is_local, created_at FROM servers').all();
    
    // Fetch latest metrics for each server
    const result = servers.map(server => {
      const latestMetrics = db.prepare(`
        SELECT * FROM metrics_history 
        WHERE server_id = ? 
        ORDER BY timestamp DESC LIMIT 1
      `).get(server.id);

      return {
        ...server,
        currentMetrics: latestMetrics || {
          cpu_usage: 0,
          ram_usage: 0,
          ram_used_mb: 0,
          ram_total_mb: 0,
          bandwidth_rx_speed: 0,
          bandwidth_tx_speed: 0,
          disk_usage: 0,
          ping_ms: 0,
          status: 'unknown'
        }
      };
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add a new VPS
router.post('/vps', (req, res) => {
  try {
    const { name, host, port, username, auth_type, password, private_key } = req.body;

    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Name and Host IP are required.' });
    }

    const stmt = db.prepare(`
      INSERT INTO servers (name, host, port, username, auth_type, password, private_key, is_local)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `);

    const result = stmt.run(
      name,
      host,
      port || 22,
      username || 'root',
      auth_type || 'password',
      password || null,
      private_key || null
    );

    res.json({ success: true, id: result.lastInsertRowid });
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
router.delete('/vps/:id', (req, res) => {
  try {
    const { id } = req.params;
    db.prepare('DELETE FROM servers WHERE id = ?').run(id);
    db.prepare('DELETE FROM metrics_history WHERE server_id = ?').run(id);
    res.json({ success: true, message: 'VPS berhasil dihapus.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get historical metrics for a VPS (for charts)
router.get('/vps/:id/history', (req, res) => {
  try {
    const { id } = req.params;
    const history = db.prepare(`
      SELECT cpu_usage, ram_usage, ram_used_mb, ram_total_mb, bandwidth_rx_speed, bandwidth_tx_speed, disk_usage, ping_ms, timestamp
      FROM metrics_history
      WHERE server_id = ?
      ORDER BY timestamp DESC
      LIMIT 60
    `).all(id);

    res.json({ success: true, data: history.reverse() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
