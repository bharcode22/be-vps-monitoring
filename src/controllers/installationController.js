const installationService = require('../services/installationService');
const db = require('../services/db');

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

    const deployer = req.user ? (req.user.name || req.user.email) : 'Admin';

    const result = await installationService.deployPodApp({
      server_id,
      app_name,
      env: env || 'dev',
      version,
      env_filename,
      run_prisma_migrate,
      deployed_by: deployer
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

/**
 * GET /api/vps/installation/history
 * Fetch paginated deployment history with filters
 */
async function getDeploymentHistory(req, res) {
  try {
    const {
      pod_code,
      app_name,
      environment,
      status,
      search,
      page = 1,
      limit = 20
    } = req.query;

    let query = 'SELECT id, batch_id, pod_code, server_name, app_name, app_type, environment, version, env_filename, run_prisma_migrate, status, duration_seconds, error_message, deployed_by, created_at FROM deployment_history WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as total FROM deployment_history WHERE 1=1';
    const params = [];
    const countParams = [];

    if (pod_code) {
      query += ' AND pod_code = ?';
      countQuery += ' AND pod_code = ?';
      params.push(String(pod_code));
      countParams.push(String(pod_code));
    }

    if (app_name) {
      query += ' AND app_name = ?';
      countQuery += ' AND app_name = ?';
      params.push(String(app_name));
      countParams.push(String(app_name));
    }

    if (environment) {
      query += ' AND environment = ?';
      countQuery += ' AND environment = ?';
      params.push(String(environment));
      countParams.push(String(environment));
    }

    if (status) {
      query += ' AND status = ?';
      countQuery += ' AND status = ?';
      params.push(String(status));
      countParams.push(String(status));
    }

    if (search) {
      const sTerm = `%${search.trim()}%`;
      query += ' AND (server_name ILIKE ? OR version ILIKE ? OR app_name ILIKE ? OR pod_code ILIKE ?)';
      countQuery += ' AND (server_name ILIKE ? OR version ILIKE ? OR app_name ILIKE ? OR pod_code ILIKE ?)';
      params.push(sTerm, sTerm, sTerm, sTerm);
      countParams.push(sTerm, sTerm, sTerm, sTerm);
    }

    const totalCountRes = await db.get(countQuery, countParams);
    const totalRecords = parseInt(totalCountRes?.total || 0, 10);

    query += ' ORDER BY created_at DESC';

    const pageNum = Math.max(1, parseInt(page, 10));
    const limitNum = Math.max(1, Math.min(100, parseInt(limit, 10)));
    const offset = (pageNum - 1) * limitNum;

    query += ' LIMIT ? OFFSET ?';
    params.push(limitNum, offset);

    const rows = await db.all(query, params);

    // Calculate quick statistics
    const statsRes = await db.get(`
      SELECT 
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'success' THEN 1 END) as success_count,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed_count
      FROM deployment_history
    `);

    return res.json({
      success: true,
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalRecords,
        totalPages: Math.ceil(totalRecords / limitNum)
      },
      stats: {
        total: parseInt(statsRes?.total || 0, 10),
        success: parseInt(statsRes?.success_count || 0, 10),
        failed: parseInt(statsRes?.failed_count || 0, 10)
      }
    });
  } catch (err) {
    console.error('Error in getDeploymentHistory controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat riwayat deployment'
    });
  }
}

/**
 * GET /api/vps/installation/history/:id
 * Get full deployment history detail with terminal logs
 */
async function getDeploymentDetail(req, res) {
  try {
    const { id } = req.params;
    const history = await db.get('SELECT * FROM deployment_history WHERE id = ?', [id]);
    if (!history) {
      return res.status(404).json({
        success: false,
        error: 'Riwayat deployment tidak ditemukan'
      });
    }
    return res.json({
      success: true,
      data: history
    });
  } catch (err) {
    console.error('Error in getDeploymentDetail controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat detail riwayat deployment'
    });
  }
}

/**
 * DELETE /api/vps/installation/history/:id
 * Delete a specific deployment history item
 */
async function deleteDeploymentHistory(req, res) {
  try {
    const { id } = req.params;
    await db.run('DELETE FROM deployment_history WHERE id = ?', [id]);
    return res.json({
      success: true,
      message: 'Riwayat deployment berhasil dihapus'
    });
  } catch (err) {
    console.error('Error in deleteDeploymentHistory controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menghapus riwayat deployment'
    });
  }
}

/**
 * POST /api/vps/installation/history/cleanup
 * Clean up older deployment history records
 */
async function cleanupDeploymentHistory(req, res) {
  try {
    const { keepCount = 100 } = req.body;
    await db.run(`
      DELETE FROM deployment_history 
      WHERE id NOT IN (
        SELECT id FROM deployment_history ORDER BY created_at DESC LIMIT ?
      )
    `, [Number(keepCount) || 100]);

    return res.json({
      success: true,
      message: `Berhasil membersihkan riwayat lama, menyimpan ${keepCount} rilis terbaru`
    });
  } catch (err) {
    console.error('Error in cleanupDeploymentHistory controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal membersihkan riwayat lama'
    });
  }
}

/**
 * GET /api/vps/installation/pod-versions
 * Fetch current application versions matrix per POD code
 */
async function getPodAppVersions(req, res) {
  try {
    const matrix = await installationService.getPodAppVersionsMatrix();
    return res.json({
      success: true,
      data: matrix
    });
  } catch (err) {
    console.error('Error in getPodAppVersions controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat matriks versi aplikasi POD'
    });
  }
}

/**
 * POST /api/vps/installation/pod-versions/scan
 * Trigger live SSH version scan on target PODs
 */
async function scanPodAppVersions(req, res) {
  try {
    const { server_ids } = req.body || {};
    const results = await installationService.scanAllPodAppVersions(server_ids);
    const updatedMatrix = await installationService.getPodAppVersionsMatrix();

    return res.json({
      success: true,
      message: `Pemindaian versi langsung berhasil diselesaikan (${results.length} POD)`,
      scan_results: results,
      data: updatedMatrix
    });
  } catch (err) {
    console.error('Error in scanPodAppVersions controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal melakukan pemindaian versi POD'
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
  deployApp,
  getDeploymentHistory,
  getDeploymentDetail,
  deleteDeploymentHistory,
  cleanupDeploymentHistory,
  getPodAppVersions,
  scanPodAppVersions
};
