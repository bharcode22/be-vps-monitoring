const {
  getMasterDatabases,
  getExtractorStats,
  executeExtraction,
  getSessionMonitoringSummary,
  getSessionMonitoringDetails,
  getExperienceInsightsData,
  getOrphanCleanupPreview,
  getOrphanCleanupRecords,
  executeOrphanCleanup
} = require('../services/podLogsExtractorService');

/**
 * 1. GET /api/pod-logs-extractor/masters
 * List all available Master PostgreSQL databases
 */
async function getMasters(req, res) {
  try {
    const masters = await getMasterDatabases();
    res.json({ success: true, data: masters });
  } catch (err) {
    console.error('Error fetching extractor masters:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 2. GET /api/pod-logs-extractor/stats
 * Get extraction status statistics from Master DB
 */
async function getStats(req, res) {
  try {
    const { masterId } = req.query;
    if (!masterId) {
      return res.status(400).json({ success: false, error: 'masterId query parameter is required' });
    }

    const stats = await getExtractorStats(parseInt(masterId, 10));
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('Error fetching extractor stats:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 3. POST /api/pod-logs-extractor/execute
 * Run batch extraction from pod_logs into pod_logs_extracted, play_sesion_detail, and auth_detail
 */
async function execute(req, res) {
  const io = req.app.get('io');
  const isStream = req.query.stream === 'true' || req.headers.accept?.includes('text/event-stream');

  if (isStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
  }

  try {
    const {
      masterId,
      scope = 'UNEXTRACTED_ONLY',
      batchSize = 500,
      dateFrom = null,
      dateTo = null,
      podCode = null,
      activityType = null,
      maxLogs = 0
    } = req.body || {};

    if (!masterId) {
      if (isStream) {
        res.write(`data: ${JSON.stringify({ status: 'ERROR', error: 'masterId wajib diisi.' })}\n\n`);
        return res.end();
      }
      return res.status(400).json({ success: false, error: 'masterId wajib diisi.' });
    }

    const progressLogs = [];

    const result = await executeExtraction({
      masterId: parseInt(masterId, 10),
      scope,
      batchSize: parseInt(batchSize, 10) || 500,
      dateFrom,
      dateTo,
      podCode,
      activityType,
      maxLogs: parseInt(maxLogs, 10) || 0,
      onProgress: (prog) => {
        const item = {
          timestamp: new Date().toISOString(),
          ...prog
        };
        progressLogs.push(item);

        if (io) {
          io.emit('pod-logs-extractor:progress', item);
        }

        if (isStream) {
          res.write(`data: ${JSON.stringify(item)}\n\n`);
        }
      }
    });

    if (isStream) {
      res.write(`data: ${JSON.stringify({ status: 'DONE', result })}\n\n`);
      return res.end();
    }

    res.json({
      success: true,
      data: result,
      progressHistory: progressLogs.slice(-100)
    });
  } catch (err) {
    console.error('Error executing pod_logs extractor:', err.message);
    if (isStream) {
      res.write(`data: ${JSON.stringify({ status: 'ERROR', error: err.message })}\n\n`);
      return res.end();
    }
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 4. GET /api/pod-logs-extractor/monitoring/summary
 * Aggregate user & session monitoring data by date and/or POD
 */
async function getMonitoringSummary(req, res) {
  try {
    const { masterId = 5, podId, dateFrom, dateTo, groupByPod } = req.query;
    const data = await getSessionMonitoringSummary({
      masterId: parseInt(masterId, 10) || 5,
      podId: podId || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      groupByPod: groupByPod === 'true' || groupByPod === true
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching monitoring summary:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 5. GET /api/pod-logs-extractor/monitoring/details
 * Fetch individual session drilldown rows for a selected date/POD
 */
async function getMonitoringDetails(req, res) {
  try {
    const { masterId = 5, podId, date, page = 1, limit = 50, search = '' } = req.query;
    const data = await getSessionMonitoringDetails({
      masterId: parseInt(masterId, 10) || 5,
      podId: podId || null,
      date: date || null,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 50,
      search: search || ''
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching monitoring details:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 6. GET /api/pod-logs-extractor/monitoring/insights
 * Fetch comprehensive Experience Analytics (Top songs, per-pod stats, hourly peaks, completion)
 */
async function getExperienceInsights(req, res) {
  try {
    const { masterId = 5, podId, dateFrom, dateTo } = req.query;
    const data = await getExperienceInsightsData({
      masterId: parseInt(masterId, 10) || 5,
      podId: podId || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching experience insights:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 7. GET /api/pod-logs-extractor/cleanup/preview
 * Preview orphan pod records count in Master DB
 */
async function getCleanupPreview(req, res) {
  try {
    const { masterId = 5 } = req.query;
    const data = await getOrphanCleanupPreview({
      masterId: parseInt(masterId, 10) || 5
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching cleanup preview:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 8. POST /api/pod-logs-extractor/cleanup/execute
 * Execute cleanup of orphan / unregistered pod records in Master DB
 */
async function executeCleanup(req, res) {
  try {
    const { masterId = 5, cleanExtracted = true, cleanRawLogs = false } = req.body || {};
    const result = await executeOrphanCleanup({
      masterId: parseInt(masterId, 10) || 5,
      cleanExtracted: cleanExtracted === true || cleanExtracted === 'true',
      cleanRawLogs: cleanRawLogs === true || cleanRawLogs === 'true'
    });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error executing orphan cleanup:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

/**
 * 9. GET /api/pod-logs-extractor/cleanup/records
 * Fetch detailed paginated orphan records for inspection prior to cleanup
 */
async function getCleanupRecords(req, res) {
  try {
    const { masterId = 5, table = 'play_sesion_detail', page = 1, limit = 20, search = '' } = req.query;
    const data = await getOrphanCleanupRecords({
      masterId: parseInt(masterId, 10) || 5,
      table: String(table || 'play_sesion_detail'),
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      search: String(search || '')
    });
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching cleanup records:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getMasters,
  getStats,
  execute,
  getMonitoringSummary,
  getMonitoringDetails,
  getExperienceInsights,
  getCleanupPreview,
  getCleanupRecords,
  executeCleanup
};
