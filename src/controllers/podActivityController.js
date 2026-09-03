const {
  getPodActivityStatus,
  getOccupancyHistory,
  simulatePodActivity,
  syncAndConnectAllV3Pods
} = require('../services/podActivityService');
const { dbAsync } = require('../services/db');

const {
  getHeartbeatModulesConfig,
  saveHeartbeatModulesConfig,
  resetHeartbeatModulesConfig,
  getHeartbeatThresholdsConfig,
  saveHeartbeatThresholdsConfig,
  resetHeartbeatThresholdsConfig
} = require('../services/podHeartbeatConfigService');

const {
  getPodEvents,
  getPodState,
  getPodHeartbeatStream,
  getPodLogDates,
  getPodStorageFilesList,
  streamPodHeartbeatsDownload,
  getRecentFleetIncidents,
  getPodEventsLogPath,
  getPodHeartbeatsLogPath
} = require('../services/podStorageService');

/**
 * GET /api/pod-activity/status
 * Get current real-time status of all POD V3 units, summary counts, and recent logs
 */
async function getStatus(req, res) {
  try {
    const data = await getPodActivityStatus();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching POD activity status:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/history
 * Get paginated occupancy transition history
 */
async function getHistory(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const offset = parseInt(req.query.offset, 10) || 0;
    const serverId = req.query.serverId ? parseInt(req.query.serverId, 10) : null;

    const data = await getOccupancyHistory(limit, offset, serverId);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching POD activity history:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/simulate
 * Test injector to simulate or inject an occupancy value (1 or 0)
 */
async function simulate(req, res) {
  try {
    const { serverId, value, topic } = req.body;
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'serverId wajib diisi.' });
    }

    const result = await simulatePodActivity({ serverId, value, topic });
    res.json(result);
  } catch (err) {
    console.error('Error simulating POD activity:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/reconnect
 * Reconnect and resynchronize MQTT clients to all POD V3 units
 */
async function reconnect(req, res) {
  try {
    await syncAndConnectAllV3Pods();
    const data = await getPodActivityStatus();
    res.json({ success: true, message: 'Berhasil menghubungkan ulang broker MQTT seluruh POD V3', data });
  } catch (err) {
    console.error('Error reconnecting POD activity MQTT:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/heartbeat-modules
 * Get list of configured heartbeat modules from JSON file
 */
async function getHeartbeatModules(req, res) {
  try {
    const data = getHeartbeatModulesConfig();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error getting heartbeat modules:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/heartbeat-modules
 * Save / update list of heartbeat modules to JSON file
 */
async function saveHeartbeatModules(req, res) {
  try {
    const { modules } = req.body;
    if (!Array.isArray(modules)) {
      return res.status(400).json({ success: false, error: 'Format data modul harus berupa array.' });
    }

    const saved = saveHeartbeatModulesConfig(modules);
    res.json({ success: true, message: 'Konfigurasi modul heartbeat berhasil disimpan ke file JSON!', data: saved });
  } catch (err) {
    console.error('Error saving heartbeat modules:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/heartbeat-modules/reset
 * Reset heartbeat modules config to default 9 modules in JSON file
 */
async function resetHeartbeatModules(req, res) {
  try {
    const data = resetHeartbeatModulesConfig();
    res.json({ success: true, message: 'Konfigurasi modul heartbeat berhasil direset ke default 9 modul!', data });
  } catch (err) {
    console.error('Error resetting heartbeat modules:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/heartbeat-thresholds
 * Get heartbeat status thresholds config from JSON file
 */
async function getHeartbeatThresholds(req, res) {
  try {
    const data = getHeartbeatThresholdsConfig();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error getting heartbeat thresholds:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/heartbeat-thresholds
 * Save heartbeat status thresholds config to JSON file
 */
async function saveHeartbeatThresholds(req, res) {
  try {
    const thresholds = req.body;
    const saved = saveHeartbeatThresholdsConfig(thresholds);
    res.json({ success: true, message: 'Konfigurasi ambang batas heartbeat berhasil disimpan ke file JSON!', data: saved });
  } catch (err) {
    console.error('Error saving heartbeat thresholds:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
}

/**
 * POST /api/pod-activity/heartbeat-thresholds/reset
 * Reset heartbeat status thresholds config to default in JSON file
 */
async function resetHeartbeatThresholds(req, res) {
  try {
    const data = resetHeartbeatThresholdsConfig();
    res.json({ success: true, message: 'Konfigurasi ambang batas heartbeat berhasil direset ke default!', data });
  } catch (err) {
    console.error('Error resetting heartbeat thresholds:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/pods/:id/events
 * Get daily events list for a specific pod
 */
async function getPodEventsHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const dateStr = req.query.date || null;
    const events = getPodEvents(podId, dateStr);
    res.json({ success: true, podId, date: dateStr || new Date().toISOString().split('T')[0], events });
  } catch (err) {
    console.error('Error fetching pod events:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/pods/:id/state
 * Get current state.json for a specific pod
 */
async function getPodStateHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const state = getPodState(podId);
    res.json({ success: true, podId, state });
  } catch (err) {
    console.error('Error fetching pod state:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/incidents/recent
 * Get recent incidents across all fleet pods
 */
async function getRecentIncidentsHandler(req, res) {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const incidents = getRecentFleetIncidents(limit);
    res.json({ success: true, data: incidents });
  } catch (err) {
    console.error('Error fetching recent fleet incidents:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/pods/:id/heartbeats
 * Get raw heartbeat stream for a specific pod
 */
async function getPodHeartbeatsHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const dateStr = req.query.date || null;
    const limit = parseInt(req.query.limit, 10) || 500;
    const moduleId = req.query.moduleId || null;
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;
    const source = req.query.source || 'auto';

    const heartbeats = await getPodHeartbeatStream({
      podId,
      dateStr,
      moduleId,
      startTime,
      endTime,
      limit,
      source
    });

    res.json({
      success: true,
      podId,
      date: dateStr || new Date().toISOString().split('T')[0],
      totalReturned: heartbeats.length,
      heartbeats
    });
  } catch (err) {
    console.error('Error fetching pod heartbeats:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/pods/:id/heartbeats/download
 * Download raw heartbeats file as JSON or JSONL directly from disk/stream
 */
async function downloadPodHeartbeatsHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const dateStr = req.query.date || null;
    const format = (req.query.format || 'json').toLowerCase();
    const moduleId = req.query.moduleId || null;
    const startTime = req.query.startTime || null;
    const endTime = req.query.endTime || null;

    let serverName = null;
    try {
      const server = await dbAsync.get('SELECT name FROM servers WHERE id = ?', [podId]);
      if (server && server.name) {
        serverName = server.name;
      }
    } catch (_) {}

    streamPodHeartbeatsDownload({
      podId,
      serverName,
      dateStr,
      format,
      moduleId,
      startTime,
      endTime,
      res
    });
  } catch (err) {
    console.error('Error downloading pod heartbeats:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
}

/**
 * GET /api/pod-activity/pods/:id/log-dates
 * Get list of available recorded dates for a specific pod
 */
async function getPodLogDatesHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const dates = getPodLogDates(podId);
    res.json({ success: true, podId, dates });
  } catch (err) {
    console.error('Error fetching pod log dates:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * GET /api/pod-activity/pods/:id/storage-files
 * Return list of physical files in pod_storage for a pod
 */
function getPodStorageFilesHandler(req, res) {
  try {
    const podId = parseInt(req.params.id, 10);
    const result = getPodStorageFilesList(podId);
    res.json(result);
  } catch (err) {
    console.error('Error fetching pod storage files:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getStatus,
  getHistory,
  simulate,
  reconnect,
  getHeartbeatModules,
  saveHeartbeatModules,
  resetHeartbeatModules,
  getHeartbeatThresholds,
  saveHeartbeatThresholds,
  resetHeartbeatThresholds,
  getPodEventsHandler,
  getPodStateHandler,
  getRecentIncidentsHandler,
  getPodHeartbeatsHandler,
  downloadPodHeartbeatsHandler,
  getPodLogDatesHandler,
  getPodStorageFilesHandler
};
