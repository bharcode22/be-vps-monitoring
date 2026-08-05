const dbAsync = require('../services/db');
const { fetchRabbitMqStatus } = require('../services/rabbitmqService');

/**
 * Get all RabbitMQ servers
 */
const getRabbitMqs = async (req, res) => {
  try {
    const servers = await dbAsync.all('SELECT id, name, host, port, username, password, created_at FROM rabbitmq_servers ORDER BY created_at DESC');
    res.json({ success: true, data: servers });
  } catch (err) {
    console.error('Failed to get RabbitMQs:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Add a new RabbitMQ server
 */
const createRabbitMq = async (req, res) => {
  try {
    const { name, host, port, username, password } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Name and Host are required' });
    }

    const r = await dbAsync.run(
      'INSERT INTO rabbitmq_servers (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [name, host, port || 15672, username || 'guest', password || '']
    );

    res.json({
      success: true,
      message: 'RabbitMQ server added successfully',
      data: { id: r.lastID, name, host, port: port || 15672, username: username || 'guest' }
    });
  } catch (err) {
    console.error('Failed to create RabbitMQ:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Update an existing RabbitMQ server
 */
const updateRabbitMq = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, host, port, username, password } = req.body;
    if (!name || !host) {
      return res.status(400).json({ success: false, error: 'Name and Host are required' });
    }

    const existing = await dbAsync.get('SELECT * FROM rabbitmq_servers WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'RabbitMQ server not found' });
    }

    await dbAsync.run(
      'UPDATE rabbitmq_servers SET name = ?, host = ?, port = ?, username = ?, password = ? WHERE id = ?',
      [name, host, port || 15672, username || 'guest', password || '', id]
    );

    res.json({ success: true, message: 'RabbitMQ server updated successfully' });
  } catch (err) {
    console.error('Failed to update RabbitMQ:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Delete a RabbitMQ server
 */
const deleteRabbitMq = async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await dbAsync.get('SELECT * FROM rabbitmq_servers WHERE id = ?', [id]);
    if (!existing) {
      return res.status(404).json({ success: false, error: 'RabbitMQ server not found' });
    }

    await dbAsync.run('DELETE FROM rabbitmq_servers WHERE id = ?', [id]);
    res.json({ success: true, message: 'RabbitMQ server deleted successfully' });
  } catch (err) {
    console.error('Failed to delete RabbitMQ:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Fetch Health & Status stats from a RabbitMQ server
 */
const getRabbitMqStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM rabbitmq_servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'RabbitMQ server not found' });
    }

    const statusData = await fetchRabbitMqStatus(server);
    res.json({ success: true, data: statusData });
  } catch (err) {
    console.error(`Failed to get status for RabbitMQ ${req.params.id}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Handle trace event webhook from publisher/subscriber client applications
 */
const receiveTraceEvent = async (req, res) => {
  try {
    const { traceId, action, serverName, payload } = req.body;
    if (!traceId || !action || !serverName) {
      return res.status(400).json({ success: false, error: 'traceId, action, and serverName are required' });
    }

    const io = req.app.get('io');

    // Tambahkan log ini untuk debug di backend monitoring terminal
    console.log(`[DEBUG-WEBHOOK] Action: ${action.toUpperCase()} | Server: ${serverName} | TraceID: ${traceId}`);

    if (io) {
      io.emit('rabbitmq:webhook-trace', {
        timestamp: new Date().toLocaleTimeString(),
        traceId,
        action, // 'publish' | 'subscribe'
        serverName, // e.g. 'VPS-Admin (admin-backend)' or 'Pod-Ibiza (mobile-synch)'
        payload: payload || null
      });
    }

    res.json({ success: true, message: 'Event broadcasted successfully' });
  } catch (err) {
    console.error('Failed to process trace webhook event:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getRabbitMqs,
  createRabbitMq,
  updateRabbitMq,
  deleteRabbitMq,
  getRabbitMqStatus,
  receiveTraceEvent
};
