const tncSyncService = require('../services/tncSyncService');

/**
 * POST /api/tnc-sync/publish-definitions
 */
const publishDefinitions = async (req, res) => {
  try {
    const { masterId, targetPodIds } = req.body;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'masterId wajib diisi.' });
    }
    
    const result = await tncSyncService.publishDefinitions(Number(masterId), targetPodIds);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/tnc-sync/pull-consents
 */
const pullConsentsAndDistribute = async (req, res) => {
  try {
    const { masterId, sourcePodIds } = req.body;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'masterId wajib diisi.' });
    }
    
    const result = await tncSyncService.pullConsentsAndDistribute(Number(masterId), sourcePodIds);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  publishDefinitions,
  pullConsentsAndDistribute
};
