const dbAsync = require('../services/db');
const { readPodConfig, updatePodConfig: updatePodConfigService } = require('../services/podConfigService');

/**
 * Get Pod Configuration & available sound list for a specific server
 */
const getPodConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    if (server.type !== 'pod') {
      return res.status(400).json({ success: false, error: 'Layanan ini bukan bertipe Pod' });
    }

    const data = await readPodConfig(server);
    res.json({ success: true, server_id: server.id, data });
  } catch (err) {
    console.error(`Get Pod Config Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Update Pod Configuration for a specific server
 */
const updatePodConfig = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    if (server.type !== 'pod') {
      return res.status(400).json({ success: false, error: 'Layanan ini bukan bertipe Pod' });
    }

    const newConfig = req.body;
    if (!newConfig || typeof newConfig !== 'object') {
      return res.status(400).json({ success: false, error: 'Payload konfigurasi tidak valid' });
    }

    const result = await updatePodConfigService(server, newConfig);
    res.json({ success: true, message: result.message });
  } catch (err) {
    console.error(`Update Pod Config Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getPodConfig,
  updatePodConfig
};
