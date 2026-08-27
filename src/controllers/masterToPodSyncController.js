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
 * GET /api/master-pod-sync/master-table-fast?masterId=X&table=Y
 * Instant fetch of Master table schema & rows, plus POD server list (NOT_LOADED)
 */
const getMasterTableFast = async (req, res) => {
  try {
    const { masterId, table } = req.query;
    if (!masterId || !table) {
      return res.status(400).json({ success: false, error: 'Parameter masterId dan table wajib diisi.' });
    }
    const data = await masterToPodSyncService.getMasterTableFast(Number(masterId), table);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/master-pod-sync/compare-single-pod?masterId=X&table=Y&podId=Z
 * On-demand comparison between Master DB and a single specific POD (~200ms)
 */
const compareSinglePod = async (req, res) => {
  try {
    const { masterId, table, podId } = req.query;
    if (!masterId || !table || !podId) {
      return res.status(400).json({ success: false, error: 'Parameter masterId, table, dan podId wajib diisi.' });
    }
    const result = await masterToPodSyncService.compareMasterTableWithSinglePod(
      Number(masterId),
      table,
      Number(podId)
    );
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
    const { masterId, tableName, pkColumn, pkValue, pkValues, cascade } = req.body;
    const values = Array.isArray(pkValues) && pkValues.length > 0 ? pkValues : (pkValue !== undefined ? [pkValue] : []);
    if (!masterId || !tableName || values.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tableName, dan pkValue/pkValues wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.deleteMasterTableRow({
      masterId: Number(masterId),
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue,
      pkValues: values,
      cascade: cascade !== false
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
    const { serverId, serverIds, tableName, pkColumn, pkValue, pkValues, cascade } = req.body;
    const values = Array.isArray(pkValues) && pkValues.length > 0 ? pkValues : (pkValue !== undefined ? [pkValue] : []);
    const targetIds = Array.isArray(serverIds) && serverIds.length > 0
      ? serverIds.map(Number)
      : (serverId ? [Number(serverId)] : []);

    if (targetIds.length === 0 || !tableName || values.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'serverId/serverIds, tableName, dan pkValue/pkValues wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.deletePodTableRow({
      serverId: targetIds[0],
      serverIds: targetIds,
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue,
      pkValues: values,
      cascade: cascade !== false
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

/**
 * POST /api/master-pod-sync/pod-to-master
 */
const syncPodToMaster = async (req, res) => {
  try {
    const { masterId, serverId, tableName, dryRun, dateFrom, dateTo } = req.body;
    if (!masterId || !serverId || !tableName) {
      return res.status(400).json({
        success: false,
        error: 'masterId, serverId, dan tableName wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.syncPodTableToMaster({
      masterId: Number(masterId),
      serverId: Number(serverId),
      tableName,
      dryRun: Boolean(dryRun),
      dateFrom,
      dateTo
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/sync-single-pod-row
 */
const syncSinglePodRow = async (req, res) => {
  try {
    const { masterId, serverId, serverIds, tableName, pkColumn, pkValue, rowData } = req.body;
    const targetIds = Array.isArray(serverIds) && serverIds.length > 0
      ? serverIds.map(Number)
      : (serverId ? [Number(serverId)] : []);

    if (!masterId || !tableName || (pkValue === undefined && !rowData)) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tableName, dan pkValue/rowData wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.syncSinglePodRowToMaster({
      masterId: Number(masterId),
      serverId: targetIds[0] || null,
      serverIds: targetIds,
      tableName,
      pkColumn: pkColumn || 'id',
      pkValue,
      rowData
    });

    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/master-pod-sync/relations?masterId=X&table=Y
 */
const getTableRelations = async (req, res) => {
  try {
    const { masterId, table } = req.query;
    if (!masterId || !table) {
      return res.status(400).json({ success: false, error: 'Parameter masterId dan table wajib diisi.' });
    }
    const relations = await masterToPodSyncService.getTableRelations(Number(masterId), table);
    res.json({ success: true, data: relations });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/sync-relational
 */
const syncRelationalTables = async (req, res) => {
  try {
    const { masterId, primaryTable, tablesToSync, targetPodIds, dryRun, syncColumns, syncData } = req.body;
    if (!masterId || !tablesToSync || tablesToSync.length === 0 || !targetPodIds || targetPodIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'masterId, tablesToSync, dan targetPodIds wajib disertakan.'
      });
    }

    const result = await masterToPodSyncService.syncRelationalTablesToPods({
      masterId: Number(masterId),
      primaryTable,
      tablesToSync,
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
 * GET /api/master-pod-sync/fleet-audit?masterId=X
 */
const getFleetAudit = async (req, res) => {
  try {
    const { masterId } = req.query;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'Parameter masterId wajib diisi.' });
    }
    const auditData = await masterToPodSyncService.auditFleetDiscrepancies(Number(masterId));
    res.json({ success: true, data: auditData });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/clean-master-duplicates
 */
const cleanMasterDuplicates = async (req, res) => {
  try {
    const { masterId, tableName, conflictCols } = req.body;
    if (!masterId || !tableName || !conflictCols) {
      return res.status(400).json({ success: false, error: 'masterId, tableName, dan conflictCols wajib diisi.' });
    }
    const result = await masterToPodSyncService.cleanMasterDuplicates(Number(masterId), tableName, conflictCols);
    let msgParts = [];
    if (result.obsoleteCount > 0) {
      msgParts.push(`${result.obsoleteCount} baris jawaban dari pertanyaan nonaktif/usang dipindahkan ke history`);
    }
    if (result.duplicateDeletedCount > 0) {
      msgParts.push(`${result.duplicateDeletedCount} baris duplikat lama dibersihkan`);
    }
    const detailStr = msgParts.length > 0 ? ` (${msgParts.join(', ')})` : '';

    const msg = result.archivedCount > 0
      ? `Sukses! Total ${result.archivedCount} baris data berhasil diarsipkan ke "${result.historyTableName}", dan ${result.deletedCount} baris dibersihkan dari "${tableName}"${detailStr}.`
      : `Sukses! ${result.deletedCount} baris data berhasil dibersihkan dari "${tableName}".`;

    res.json({ success: true, data: result, message: msg });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/master-pod-sync/check-master-duplicates
 */
const checkMasterDuplicates = async (req, res) => {
  try {
    const { masterId, tableName, conflictCols } = req.body;
    if (!masterId || !tableName || !conflictCols) {
      return res.status(400).json({ success: false, error: 'masterId, tableName, dan conflictCols wajib diisi.' });
    }
    const result = await masterToPodSyncService.checkMasterDuplicates(Number(masterId), tableName, conflictCols);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getMasterDatabases,
  getMasterTables,
  getMasterTableFast,
  compareSinglePod,
  getTableComparisonMatrix,
  getTableRelations,
  performSync,
  syncRelationalTables,
  deleteMasterRow,
  deletePodRow,
  syncSingleMasterRow,
  syncPodToMaster,
  syncSinglePodRow,
  getFleetAudit,
  checkMasterDuplicates,
  cleanMasterDuplicates
};
