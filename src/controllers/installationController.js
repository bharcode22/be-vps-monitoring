const installationService = require('../services/installationService');

/**
 * GET /api/vps/installation/env-files
 * Fetch available .env configuration files in backend/envoirment
 */
async function getEnvFiles(req, res) {
  try {
    const result = await installationService.getEnvFiles();
    return res.json(result);
  } catch (err) {
    console.error('Error in getEnvFiles controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengambil daftar file .env'
    });
  }
}

/**
 * GET /api/vps/installation/versions
 * Fetch available artifact versions for an application and environment from MinIO
 */
async function getVersions(req, res) {
  try {
    const { app_name, env } = req.query;
    const result = await installationService.getInstallationVersions({
      app_name: app_name || 'mobile-api',
      env: env || 'dev'
    });
    return res.json(result);
  } catch (err) {
    console.error('Error in getVersions controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengambil daftar versi instalasi'
    });
  }
}

/**
 * POST /api/vps/installation/deploy
 * Execute automated deployment on target POD v3 server
 */
async function deployApp(req, res) {
  try {
    const { server_id, app_name, env, version, env_filename, run_prisma_migrate } = req.body;
    if (!server_id || !app_name || !version) {
      return res.status(400).json({
        success: false,
        error: 'server_id, app_name, dan version wajib diisi'
      });
    }

    const result = await installationService.deployPodApp({
      server_id,
      app_name,
      env: env || 'dev',
      version,
      env_filename,
      run_prisma_migrate
    });

    if (!result.success) {
      return res.status(500).json(result);
    }

    return res.json(result);
  } catch (err) {
    console.error('Error in deployApp controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengeksekusi deployment ke server POD v3'
    });
  }
}

module.exports = {
  getEnvFiles,
  getVersions,
  deployApp
};
