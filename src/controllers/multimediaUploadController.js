const { getAuthToken } = require('../services/multimediaUploadService');

/**
 * Controller for providing Master API JWT token to frontend for high-speed direct upload
 */
const getMasterApiToken = async (req, res) => {
  try {
    const token = await getAuthToken();
    return res.json({
      success: true,
      token,
      masterApiBase: process.env.MASTER_API_BASE || 'https://be-api.regenesispod.com/admin-api'
    });
  } catch (err) {
    console.error('Error fetching master token for direct upload:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengautentikasi Master API'
    });
  }
};

module.exports = {
  getMasterApiToken
};
