const { testConnection, compareSchemas } = require('../services/sync/dbAnalyzer');
const { performSync } = require('../services/sync/dbSyncer');

/**
 * GET /api/sync/info
 * Returns default environment connection strings
 */
const getSyncInfo = (req, res) => {
  res.json({
    success: true,
    defaults: {
      sourceUrl: process.env.SOURCE_DATABASE_URL || '',
      targetUrl: process.env.TARGET_DATABASE_URL || ''
    }
  });
};

/**
 * POST /api/sync/test-connection
 * Tests PostgreSQL connections for Source and Target
 */
const testSyncConnections = async (req, res) => {
  const { sourceUrl, targetUrl } = req.body;

  if (!sourceUrl || !targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Harap isi connection string PostgreSQL untuk Source dan Target.'
    });
  }

  try {
    const [sourceResult, targetResult] = await Promise.all([
      testConnection(sourceUrl),
      testConnection(targetUrl)
    ]);

    const allConnected = sourceResult.success && targetResult.success;

    res.json({
      success: allConnected,
      message: allConnected
        ? 'Koneksi ke database Source dan Target berhasil terverifikasi!'
        : 'Satu atau lebih database gagal terhubung.',
      source: sourceResult,
      target: targetResult
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal menguji koneksi database.'
    });
  }
};

/**
 * POST /api/sync/test-single
 * Tests a single PostgreSQL database connection (Source or Target)
 */
const testSingleConnection = async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({
      success: false,
      error: 'Harap isi connection string PostgreSQL.'
    });
  }

  try {
    const result = await testConnection(url);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal terhubung ke database.'
    });
  }
};

/**
 * POST /api/sync/compare-schema
 * Compares table and column structures between Source and Target DBs
 */
const compareSyncSchema = async (req, res) => {
  const { sourceUrl, targetUrl } = req.body;

  if (!sourceUrl || !targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Harap isi connection string PostgreSQL untuk Source dan Target.'
    });
  }

  try {
    const result = await compareSchemas(sourceUrl, targetUrl);
    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal membandingkan skema database.'
    });
  }
};

/**
 * POST /api/sync/perform
 * Performs data synchronization from Source DB to Target DB
 */
const executeSync = async (req, res) => {
  const { sourceUrl, targetUrl, dryRun = false, tables = null, batchSize = 500 } = req.body;

  if (!sourceUrl || !targetUrl) {
    return res.status(400).json({
      success: false,
      error: 'Harap isi connection string PostgreSQL untuk Source dan Target.'
    });
  }

  try {
    const result = await performSync({
      sourceUrl,
      targetUrl,
      dryRun,
      tables,
      batchSize: parseInt(batchSize, 10) || 500
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengesksekusi sinkronisasi database.'
    });
  }
};

module.exports = {
  getSyncInfo,
  testSyncConnections,
  testSingleConnection,
  compareSyncSchema,
  executeSync
};
