const installationService = require('../services/installationService');

/**
 * Controller for Bundle Version Management & POD Compliance Matrix
 */

/**
 * GET /api/vps/installation/bundles
 * Get all bundle definitions
 */
async function getBundles(req, res) {
  try {
    const { env } = req.query;
    const bundles = await installationService.getAllBundleDefinitions(env || null);
    return res.json({
      success: true,
      data: bundles || []
    });
  } catch (err) {
    console.error('Error in getBundles controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat daftar bundle'
    });
  }
}

/**
 * GET /api/vps/installation/bundles/:id
 * Get single bundle details
 */
async function getBundleDetail(req, res) {
  try {
    const { id } = req.params;
    const bundle = await installationService.getBundleDefinitionById(Number(id));
    if (!bundle) {
      return res.status(404).json({
        success: false,
        error: 'Bundle tidak ditemukan'
      });
    }
    return res.json({
      success: true,
      data: bundle
    });
  } catch (err) {
    console.error('Error in getBundleDetail controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat detail bundle'
    });
  }
}

/**
 * POST /api/vps/installation/bundles
 * Create a new bundle definition
 */
async function createBundle(req, res) {
  try {
    const {
      bundle_name,
      bundle_version
    } = req.body;

    if (!bundle_name || !bundle_version) {
      return res.status(400).json({
        success: false,
        error: 'Nama bundle dan versi bundle wajib diisi'
      });
    }

    const deployer = req.user?.name || req.user?.email || 'Admin';

    const newBundle = await installationService.createBundleDefinition({
      ...req.body,
      created_by: deployer
    });

    return res.status(201).json({
      success: true,
      message: `Bundle '${bundle_name}' berhasil dibuat`,
      data: newBundle
    });
  } catch (err) {
    console.error('Error in createBundle controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal membuat bundle baru'
    });
  }
}

/**
 * PUT /api/vps/installation/bundles/:id
 * Update an existing bundle definition
 */
async function updateBundle(req, res) {
  try {
    const { id } = req.params;
    const updated = await installationService.updateBundleDefinition(Number(id), req.body);
    return res.json({
      success: true,
      message: 'Bundle berhasil diperbarui',
      data: updated
    });
  } catch (err) {
    console.error('Error in updateBundle controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memperbarui bundle'
    });
  }
}

/**
 * DELETE /api/vps/installation/bundles/:id
 * Delete a bundle definition
 */
async function deleteBundle(req, res) {
  try {
    const { id } = req.params;
    await installationService.deleteBundleDefinition(Number(id));
    return res.json({
      success: true,
      message: 'Bundle berhasil dihapus'
    });
  } catch (err) {
    console.error('Error in deleteBundle controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menghapus bundle'
    });
  }
}

/**
 * GET /api/vps/installation/bundles/pod-matrix
 * Get POD v3 bundle compliance matrix
 */
async function getPodBundleMatrix(req, res) {
  try {
    const matrix = await installationService.getPodBundleMatrix();
    return res.json({
      success: true,
      data: matrix || []
    });
  } catch (err) {
    console.error('Error in getPodBundleMatrix controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat matriks bundle POD'
    });
  }
}

/**
 * POST /api/vps/installation/bundles/assign
 * Assign bundle to POD
 */
async function assignPodBundle(req, res) {
  try {
    const { pod_code, bundle_id } = req.body;
    if (!pod_code) {
      return res.status(400).json({
        success: false,
        error: 'pod_code wajib diisi'
      });
    }

    const deployer = req.user?.name || req.user?.email || 'Admin';
    const result = await installationService.assignPodBundleState({
      pod_code,
      bundle_id,
      deployed_by: deployer
    });

    return res.json({
      success: true,
      message: `Bundle berhasil di-assign ke POD #${pod_code}`,
      data: result
    });
  } catch (err) {
    console.error('Error in assignPodBundle controller:', err);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menugaskan bundle ke POD'
    });
  }
}

module.exports = {
  getBundles,
  getBundleDetail,
  createBundle,
  updateBundle,
  deleteBundle,
  getPodBundleMatrix,
  assignPodBundle
};
