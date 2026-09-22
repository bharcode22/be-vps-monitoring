const {
  getMasterDatabases,
  getExtractorStats,
  executeExtraction
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

module.exports = {
  getMasters,
  getStats,
  execute
};
