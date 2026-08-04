const dbAsync = require('../services/db');
const { validateSoundsMetadata, compareSoundsForPods, compareMetadataForPods } = require('../services/soundService');

/**
 * Validate sound & video metadata.json against physical server files
 */
const validateSounds = async (req, res) => {
  try {
    const { id } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan' });
    }

    const data = await validateSoundsMetadata(server);
    res.json({ success: true, server_id: server.id, data });
  } catch (err) {
    console.error(`Sounds Validation Error (Server ${req.params.id}):`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Compare all sounds across pod servers
 */
const compareAllPodSounds = async (req, res) => {
  try {
    const { version } = req.query; // 'v2', 'v3', or 'all'

    let query = "SELECT * FROM servers WHERE type = 'pod'";
    let params = [];

    if (version && version !== 'all') {
      query += " AND pod_version = ?";
      params.push(version);
    }

    const pods = await dbAsync.all(query, params);

    if (!pods || pods.length === 0) {
      return res.json({ success: true, data: { pods: [], files: {}, totalFiles: 0 } });
    }

    const data = await compareSoundsForPods(pods);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Compare Sounds Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Compare all metadata across pod servers
 */
const compareAllPodMetadata = async (req, res) => {
  try {
    const { version } = req.query; // 'v2', 'v3', or 'all'

    let query = "SELECT * FROM servers WHERE type = 'pod'";
    let params = [];

    if (version && version !== 'all') {
      query += " AND pod_version = ?";
      params.push(version);
    }

    const pods = await dbAsync.all(query, params);

    if (!pods || pods.length === 0) {
      return res.json({ success: true, data: { pods: [], metadataMatrix: {}, totalItems: 0 } });
    }

    const data = await compareMetadataForPods(pods);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Compare Metadata Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  validateSounds,
  compareAllPodSounds,
  compareAllPodMetadata
};
