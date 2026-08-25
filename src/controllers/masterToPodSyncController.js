const masterToPodSyncService = require('../services/masterToPodSyncService');

/**
 * GET /api/master-pod-sync/masters
 */
const getMasterDatabases = async (req, res) => {
  try {
    const masters = await masterToPodSyncService.getMasterDatabases();
    res.json({ success: true, data: masters });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/master-pod-sync/tables?masterId=X
 */
const getMasterTables = async (req, res) => {
  try {
    const { masterId } = req.query;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'Parameter masterId wajib diisi.' });
    }
    const result = await masterToPodSyncService.getMasterTables(Number(masterId));
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/master-pod-sync/matrix?masterId=X&table=Y
 */
const getTableComparisonMatrix = async (req, res) => {
  try {
    const { masterId, table } = req.query;
    if (!masterId || !table) {
      return res.status(400).json({ success: false, error: 'Parameter masterId dan table wajib diisi.' });
    }
    const matrix = await masterToPodSyncService.compareMasterTableAcrossPods(Number(masterId), table);
    res.json({ success: true, data: matrix });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/sync
 */
const performSync = async (req, res) => {
  try {
    const { masterId, tableName, targetPodIds, dryRun, syncColumns, syncData } = req.body;
    if (!masterId || !tableName || !targetPodIds || targetPodIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tableName, dan targetPodIds wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.syncMasterTableToPods({
      masterId: Number(masterId),
      tableName,
      targetPodIds,
      dryRun: Boolean(dryRun),
      syncColumns: syncColumns !== false,
      syncData: syncData !== false
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/master-pod-sync/master-row
 */
const deleteMasterRow = async (req, res) => {
  try {
    const { masterId, tableName, pkColumn, pkValue } = req.body;
    if (!masterId || !tableName || pkValue === undefined) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tableName, dan pkValue wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.deleteMasterTableRow({
      masterId: Number(masterId),
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * DELETE /api/master-pod-sync/pod-row
 */
const deletePodRow = async (req, res) => {
  try {
    const { serverId, tableName, pkColumn, pkValue } = req.body;
    if (!serverId || !tableName || pkValue === undefined) {
      return res.status(400).json({
        success: false,
        error: 'serverId, tableName, dan pkValue wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.deletePodTableRow({
      serverId: Number(serverId),
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/sync-single-row
 */
const syncSingleMasterRow = async (req, res) => {
  try {
    const { masterId, tableName, pkColumn, pkValue, targetPodIds } = req.body;
    if (!masterId || !tableName || pkValue === undefined || !targetPodIds || targetPodIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tableName, pkValue, dan targetPodIds wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.syncSingleMasterRowToPods({
      masterId: Number(masterId),
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue,
      targetPodIds
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getMasterDatabases,
  getMasterTables,
  getTableComparisonMatrix,
  performSync,
  deleteMasterRow,
  deletePodRow,
  syncSingleMasterRow
};
