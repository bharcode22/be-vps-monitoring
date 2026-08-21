const dbAsync = require('../services/db');
const { encrypt } = require('../utils/crypto');
const { fetchRabbitMqStatus } = require('../services/rabbitmqService');
const { exec } = require('child_process');

/**
 * Get all RabbitMQ servers
 */
const getRabbitMqs = async (req, res) => {
  try {
    const servers = await dbAsync.all('SELECT id, name, host, port, username, password, created_at FROM rabbitmq_servers ORDER BY created_at DESC');
    const sanitized = servers.map(s => ({
      ...s,
      password: s.password ? '******' : ''
    }));
    res.json({ success: true, data: sanitized });
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

    const encPassword = password ? encrypt(password) : '';
    const r = await dbAsync.run(
      'INSERT INTO rabbitmq_servers (name, host, port, username, password) VALUES (?, ?, ?, ?, ?)',
      [name, host, port || 15672, username || 'guest', encPassword]
    );

    res.json({
      success: true,
      message: 'RabbitMQ server added successfully',
      data: { id: r.lastInsertRowid || r.lastID, name, host, port: port || 15672, username: username || 'guest' }
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

    const finalPassword = (password && password !== '******') ? encrypt(password) : existing.password;

    await dbAsync.run(
      'UPDATE rabbitmq_servers SET name = ?, host = ?, port = ?, username = ?, password = ? WHERE id = ?',
      [name, host, port || 15672, username || 'guest', finalPassword, id]
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

/**
 * Execute command locally (as requested for RabbitMQ/Pod restart)
 * NOTE: In a real multi-server environment, this should SSH into the specific node.
 */
const executeCommand = async (req, res) => {
  try {
    const { command } = req.body;
    if (!command) {
      return res.status(400).json({ success: false, error: 'Command is required' });
    }

    // Security check: Only allow specific commands
    const allowedPrefixes = ['pm2 restart', 'docker restart'];
    const isAllowed = allowedPrefixes.some(prefix => command.startsWith(prefix));
    
    if (!isAllowed) {
      return res.status(403).json({ success: false, error: 'Command not allowed for security reasons' });
    }

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Execution error: ${error.message}`);
        return res.status(500).json({ success: false, error: error.message, details: stderr });
      }
      res.json({ success: true, message: stdout.trim() || 'Executed successfully' });
    });
  } catch (err) {
    console.error('Failed to execute command:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getRabbitMqs,
  createRabbitMq,
  updateRabbitMq,
  deleteRabbitMq,
  getRabbitMqStatus,
  receiveTraceEvent,
  executeCommand
};
