const directS3Service = require('../services/directS3Service');

/**
 * Controller: Generate Presigned S3 URLs for Direct Upload
 */
const getPresignedUrls = async (req, res) => {
  try {
    const { sound_scape, files } = req.body;
    if (!sound_scape) {
      return res.status(400).json({ success: false, error: 'Kode sound_scape wajib diisi' });
    }
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ success: false, error: 'Daftar berkas (files) wajib diisi' });
    }

    const data = await directS3Service.generateDirectS3PresignedUrls(sound_scape, files);
    return res.json({
      success: true,
      ...data
    });
  } catch (err) {
    console.error('Error generating presigned S3 URLs:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal membuat URL Presigned S3'
    });
  }
};

/**
 * Controller: Save Multimedia Metadata & Media Forensik (SHA-256)
 */
const saveMetadataAndForensics = async (req, res) => {
  try {
    const payload = req.body;
    if (!payload || !payload.sound_scape) {
      return res.status(400).json({ success: false, error: 'Payload tidak valid: sound_scape wajib diisi' });
    }

    const result = await directS3Service.saveDirectMultimediaWithForensics(payload);
    return res.json(result);
  } catch (err) {
    console.error('Error saving direct multimedia metadata with forensics:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menyimpan metadata ke tabel multimedia dan media_forensik'
    });
  }
};

module.exports = {
  getPresignedUrls,
  saveMetadataAndForensics
};
