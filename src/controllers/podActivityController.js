const {
  getPodActivityStatus,
  getOccupancyHistory,
  simulatePodActivity,
  syncAndConnectAllV3Pods
} = require('../services/podActivityService');

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

module.exports = {
  getStatus,
  getHistory,
  simulate,
  reconnect
};
