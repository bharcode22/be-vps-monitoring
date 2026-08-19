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
 * GET /api/vps/installation/minio-artifacts/details
 * Fetch detailed artifact versions with file list & sizes
 */
async function getArtifactDetails(req, res) {
  try {
    const { app_name, env } = req.query;
    const result = await installationService.getDetailedArtifactVersions({
      app_name: app_name || 'mobile-api',
      env: env || 'dev'
    });
    return res.json(result);
  } catch (err) {
    console.error('Error in getArtifactDetails controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengambil detail artefak MinIO'
    });
  }
}

/**
 * DELETE /api/vps/installation/minio-artifacts/version
 * Delete a single artifact version from MinIO
 */
async function deleteArtifactVersion(req, res) {
  try {
    const { app_name, env, version } = req.body;
    if (!app_name || !env || !version) {
      return res.status(400).json({
        success: false,
        error: 'app_name, env, dan version wajib diisi'
      });
    }

    const result = await installationService.deleteArtifactVersion({
      app_name,
      env,
      version
    });

    if (!result.success) {
      return res.status(400).json(result);
    }
    return res.json(result);
  } catch (err) {
    console.error('Error in deleteArtifactVersion controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menghapus versi dari MinIO'
    });
  }
}

/**
 * POST /api/vps/installation/minio-artifacts/batch-delete
 * Delete multiple artifact versions in batch
 */
async function deleteBatchArtifactVersions(req, res) {
  try {
    const { app_name, env, versions } = req.body;
    if (!app_name || !env || !Array.isArray(versions) || versions.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'app_name, env, dan daftar versions (array) wajib diisi'
      });
    }

    const result = await installationService.deleteBatchArtifactVersions({
      app_name,
      env,
      versions
    });

    return res.json(result);
  } catch (err) {
    console.error('Error in deleteBatchArtifactVersions controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal melakukan batch delete versi MinIO'
    });
  }
}

/**
 * POST /api/vps/installation/minio-artifacts/cleanup-older
 * Clean up older artifact versions, keeping N newest
 */
async function cleanupOldArtifactVersions(req, res) {
  try {
    const { app_name, env, keepCount } = req.body;
    if (!app_name || !env) {
      return res.status(400).json({
        success: false,
        error: 'app_name dan env wajib diisi'
      });
    }

    const result = await installationService.cleanupOldArtifactVersions({
      app_name,
      env,
      keepCount: Number(keepCount) || 3
    });

    return res.json(result);
  } catch (err) {
    console.error('Error in cleanupOldArtifactVersions controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal melakukan cleanup versi lama MinIO'
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
  getArtifactDetails,
  deleteArtifactVersion,
  deleteBatchArtifactVersions,
  cleanupOldArtifactVersions,
  deployApp
};
