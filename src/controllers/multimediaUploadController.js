const {
  saveChunkStream,
  dispatchToMasterApi,
  cleanupSession
} = require('../services/multimediaUploadService');

/**
 * Controller for receiving a binary chunk stream
 */
const uploadChunk = async (req, res) => {
  try {
    const uploadSessionId = req.headers['x-upload-id'] || req.query.uploadSessionId;
    const fieldName = req.headers['x-field-name'] || req.query.fieldName;
    const chunkIndex = parseInt(req.headers['x-chunk-index'] || req.query.chunkIndex, 10);
    const totalChunks = parseInt(req.headers['x-total-chunks'] || req.query.totalChunks, 10);
    const rawFilename = req.headers['x-filename'] || req.query.filename || '';
    const filename = decodeURIComponent(rawFilename);

    if (!uploadSessionId || !fieldName || isNaN(chunkIndex) || isNaN(totalChunks)) {
      return res.status(400).json({
        success: false,
        error: 'Header/query parameter chunk tidak lengkap (x-upload-id, x-field-name, x-chunk-index, x-total-chunks)'
      });
    }

    const result = await saveChunkStream(
      uploadSessionId,
      fieldName,
      chunkIndex,
      totalChunks,
      filename,
      req
    );

    return res.json({
      success: true,
      message: `Chunk ${chunkIndex + 1}/${totalChunks} untuk [${fieldName}] berhasil disimpan`,
      data: result
    });
  } catch (err) {
    console.error('Error in uploadChunk controller:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menyimpan chunk upload'
    });
  }
};

/**
 * Controller for finalizing upload, assembling files, and dispatching to Master API
 */
const completeUpload = async (req, res) => {
  try {
    const { uploadSessionId, metadata, filesManifest } = req.body;

    if (!uploadSessionId || !filesManifest) {
      return res.status(400).json({
        success: false,
        error: 'Payload complete-upload harus menyertakan uploadSessionId dan filesManifest'
      });
    }

    const io = req.app.get('io');
    const result = await dispatchToMasterApi(uploadSessionId, metadata || {}, filesManifest, io);

    return res.json({
      success: true,
      message: 'Berhasil mengunggah multimedia ke Master API & AWS S3',
      data: result
    });
  } catch (err) {
    console.error('Error in completeUpload controller:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memproses dan mengirim multimedia ke Master API'
    });
  }
};

/**
 * Controller for cancelling upload and clearing temp chunks
 */
const cancelUpload = async (req, res) => {
  try {
    const { uploadSessionId } = req.body;
    if (uploadSessionId) {
      await cleanupSession(uploadSessionId);
    }
    return res.json({
      success: true,
      message: `Sesi upload ${uploadSessionId} berhasil dibatalkan`
    });
  } catch (err) {
    console.error('Error in cancelUpload controller:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

/**
 * Controller for providing Master API token to frontend for high-speed direct upload
 */
const getMasterApiToken = async (req, res) => {
  try {
    const { getAuthToken } = require('../services/multimediaUploadService');
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
  uploadChunk,
  completeUpload,
  cancelUpload,
  getMasterApiToken
};

