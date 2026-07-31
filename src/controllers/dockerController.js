const dbAsync = require('../services/db');
const { listDockerContainers, restartDockerContainer, stopDockerContainer, getDockerContainerLogs } = require('../services/dockerService');

/**
 * Fetch all Docker containers for a specific server
 */
const getContainers = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const containers = await listDockerContainers(server);
    res.json({ success: true, server_id: server.id, data: containers });
  } catch (err) {
    console.error(`Docker List Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Restart a specific Docker container
 */
const restartContainer = async (req, res) => {
  try {
    const { id } = req.params;
    const { containerName } = req.body;

    if (!containerName) {
      return res.status(400).json({ success: false, error: 'Nama container wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await restartDockerContainer(server, containerName);
    res.json({ success: true, message: `Container ${containerName} berhasil dimuat ulang (restart).`, data: result });
  } catch (err) {
    console.error(`Docker Restart Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Stop a specific Docker container
 */
const stopContainer = async (req, res) => {
  try {
    const { id } = req.params;
    const { containerName } = req.body;

    if (!containerName) {
      return res.status(400).json({ success: false, error: 'Nama container wajib diisi.' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await stopDockerContainer(server, containerName);
    res.json({ success: true, message: `Container ${containerName} berhasil dihentikan (stop).`, data: result });
  } catch (err) {
    console.error(`Docker Stop Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Fetch logs for a specific Docker container
 */
const getContainerLogs = async (req, res) => {
  try {
    const { id, containerName } = req.params;

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const result = await getDockerContainerLogs(server, containerName);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`Docker Logs Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getContainers,
  restartContainer,
  stopContainer,
  getContainerLogs
};
