const dbAsync = require('../services/db');
const { validateSoundsMetadata } = require('../services/soundService');

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

module.exports = {
  validateSounds
};
