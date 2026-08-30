const dbAsync = require('../services/db');
const {
  getPodLogsAudit,
  pullPodLogsFleet,
  getMasterPodLogsData,
  getMasterActivityTypes,
  getPodUuidMap,
  compareSinglePodLogs,
  syncSinglePodLogRow
} = require('../services/podLogsSyncService');

/**
 * 1. GET /api/pod-logs-sync/masters
 * List all registered Master Databases
 */
async function getMasters(req, res) {
  try {
    const masters = await dbAsync.all('SELECT id, name, host, port, db_name, db_user FROM databases_postgres ORDER BY name ASC;');
    res.json({ success: true, data: masters });
  } catch (err) {
    console.error('Error fetching master databases:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 2. GET /api/pod-logs-sync/pods
 * List all registered POD V3 servers
 */
async function getPods(req, res) {
  try {
    const pods = await dbAsync.all("SELECT id, name, host, port, code, pod_version FROM servers WHERE LOWER(pod_version) = 'v3' ORDER BY name ASC;");
    res.json({ success: true, data: pods });
  } catch (err) {
    console.error('Error fetching POD V3 servers:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 3. GET /api/pod-logs-sync/audit
 * Audit pod_logs between Master DB and target POD V3s
 */
async function getAudit(req, res) {
  try {
    const masterId = req.query.masterId;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'Query parameter ?masterId=... wajib disertakan.' });
    }

    const podIds = req.query.podIds ? String(req.query.podIds).split(',').map(id => parseInt(id.trim(), 10)).filter(Boolean) : [];

    const auditData = await getPodLogsAudit(masterId, podIds);
    res.json({ success: true, data: auditData });
  } catch (err) {
    console.error('Error in getAudit controller:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 4. POST /api/pod-logs-sync/pull
 * Execute pull sync from POD V3 to Master DB with chunking
 */
async function pullLogs(req, res) {
  try {
    const { masterId, targetPodIds, options } = req.body || {};

    if (!masterId) {
      return res.status(400).json({ success: false, error: 'masterId wajib disertakan dalam request body.' });
    }

    const logs = [];
    const progressUpdates = [];

    const result = await pullPodLogsFleet({
      masterId: parseInt(masterId, 10),
      targetPodIds: Array.isArray(targetPodIds) ? targetPodIds.map(Number) : [],
      options: options || {},
      onProgress: (prog) => {
        progressUpdates.push({
          timestamp: new Date().toISOString(),
          ...prog
        });
      }
    });

    res.json({
      success: true,
      message: `Berhasil menarik ${result.totalProcessed.toLocaleString()} baris pod_logs ke Master DB.`,
      data: result,
      progressHistory: progressUpdates.slice(-50) // Return last 50 progress snapshots
    });
  } catch (err) {
    console.error('Error executing pullLogs:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 5. GET /api/pod-logs-sync/master-logs
 * Server-side paginated explorer for pod_logs on Master DB
 */
async function getMasterLogs(req, res) {
  try {
    const { masterId, page, limit, podId, activityType, search, dateFrom, dateTo } = req.query;

    if (!masterId) {
      return res.status(400).json({ success: false, error: 'Query parameter ?masterId=... wajib disertakan.' });
    }

    const data = await getMasterPodLogsData({
      masterId: parseInt(masterId, 10),
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 25,
      podId: podId || null,
      activityType: activityType || null,
      search: search || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching master pod_logs:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 6. GET /api/pod-logs-sync/activity-types
 * Distinct activity_types for dropdown filter
 */
async function getActivityTypes(req, res) {
  try {
    const masterId = req.query.masterId;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'Query parameter ?masterId=... wajib disertakan.' });
    }
    const types = await getMasterActivityTypes(parseInt(masterId, 10));
    res.json({ success: true, data: types });
  } catch (err) {
    console.error('Error fetching activity types:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 7. GET /api/pod-logs-sync/compare-pod
 * Compare pod_logs between Master DB and a specific POD V3
 */
async function comparePod(req, res) {
  try {
    const { masterId, podId, limit } = req.query;
    if (!masterId || !podId) {
      return res.status(400).json({ success: false, error: 'Parameter masterId dan podId wajib diisi.' });
    }

    const data = await compareSinglePodLogs({
      masterId: parseInt(masterId, 10),
      podId: parseInt(podId, 10),
      limit: parseInt(limit, 10) || 50
    });

    res.json({ success: true, data });
  } catch (err) {
    console.error('Error comparing POD logs:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 8. POST /api/pod-logs-sync/sync-single-row
 * Sync a single log row from POD to Master DB
 */
async function syncSingleRow(req, res) {
  try {
    const { masterId, podId, logId } = req.body || {};
    if (!masterId || !podId || !logId) {
      return res.status(400).json({ success: false, error: 'masterId, podId, dan logId wajib diisi.' });
    }

    const result = await syncSinglePodLogRow({
      masterId: parseInt(masterId, 10),
      podId: parseInt(podId, 10),
      logId: String(logId).trim()
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error syncing single log row:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 9. GET /api/pod-logs-sync/pod-uuid-map
 * Get UUID -> POD metadata mapping
 */
async function getPodUuidMapController(req, res) {
  try {
    const map = await getPodUuidMap();
    res.json({ success: true, data: map });
  } catch (err) {
    console.error('Error getting podUuidMap:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getMasters,
  getPods,
  getAudit,
  pullLogs,
  getMasterLogs,
  getActivityTypes,
  comparePod,
  syncSingleRow,
  getPodUuidMapController
};
