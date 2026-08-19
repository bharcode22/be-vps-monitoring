const {
  getEnvFiles,
  createEnvFile,
  saveEnvFile,
  deleteEnvFile,
  compareEnvFiles
} = require('../services/installationService');

/**
 * Controller: Get all environment files with parsed KV items
 */
async function getAllEnvFiles(req, res) {
  try {
    const result = await getEnvFiles();
    if (!result.success) {
      return res.status(500).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in getAllEnvFiles controller:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Create new .env file
 */
async function handleCreateEnvFile(req, res) {
  try {
    const { filename, content } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file .env wajib ditentukan' });
    }
    const result = await createEnvFile(filename, content || '');
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in handleCreateEnvFile controller:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Save / Update .env file
 */
async function handleSaveEnvFile(req, res) {
  try {
    const filename = req.params.filename || req.body.filename;
    const { content } = req.body;
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file .env wajib ditentukan' });
    }
    const result = await saveEnvFile(filename, content);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in handleSaveEnvFile controller:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Delete .env file
 */
async function handleDeleteEnvFile(req, res) {
  try {
    const filename = req.params.filename;
    if (!filename) {
      return res.status(400).json({ success: false, error: 'Nama file .env wajib ditentukan' });
    }
    const result = await deleteEnvFile(filename);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in handleDeleteEnvFile controller:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * Controller: Compare two .env files
 */
async function handleCompareEnvFiles(req, res) {
  try {
    const { sourceFileA, sourceFileB } = req.body;
    if (!sourceFileA || !sourceFileB) {
      return res.status(400).json({ success: false, error: 'Tentukan sourceFileA dan sourceFileB untuk dikomparasi' });
    }
    const result = await compareEnvFiles(sourceFileA, sourceFileB);
    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in handleCompareEnvFiles controller:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getAllEnvFiles,
  handleCreateEnvFile,
  handleSaveEnvFile,
  handleDeleteEnvFile,
  handleCompareEnvFiles
};
