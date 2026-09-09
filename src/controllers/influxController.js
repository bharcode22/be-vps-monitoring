const influxService = require('../services/influxService');

/**
 * GET /api/influx/health
 * Check InfluxDB host availability and authorization
 */
const getHealth = async (req, res) => {
  try {
    const { url, token, org, bucket } = req.query;
    let customConfig = null;
    if (url || token || org || bucket) {
      const current = await influxService.getInfluxConfig();
      customConfig = {
        url: url || current.url,
        token: token || current.token,
        org: org || current.org,
        bucket: bucket || current.bucket
      };
    }

    const result = await influxService.testConnection(customConfig);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/influx/config
 * Get current InfluxDB configuration (masking token for security)
 */
const getConfig = async (req, res) => {
  try {
    const config = await influxService.getInfluxConfig();
    return res.json({
      success: true,
      data: {
        url: config.url,
        org: config.org,
        bucket: config.bucket,
        hasToken: Boolean(config.token),
        tokenMasked: config.token
          ? (config.token.length > 8 ? `${config.token.slice(0, 4)}...${config.token.slice(-4)}` : '••••••••')
          : ''
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/influx/config
 * Save / update InfluxDB configuration
 */
const saveConfig = async (req, res) => {
  try {
    const { url, token, org, bucket } = req.body || {};
    const updated = await influxService.saveInfluxConfig({ url, token, org, bucket });

    // Re-test connection after save
    const test = await influxService.testConnection(updated);

    return res.json({
      success: true,
      message: 'Konfigurasi InfluxDB berhasil disimpan.',
      data: {
        url: updated.url,
        org: updated.org,
        bucket: updated.bucket,
        hasToken: Boolean(updated.token),
        test
      }
    });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/influx/buckets
 * Retrieve accessible InfluxDB buckets
 */
const getBuckets = async (req, res) => {
  try {
    const buckets = await influxService.getBuckets();
    return res.json({ success: true, data: buckets });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * GET /api/influx/schema
 * Retrieve measurements and keys for bucket
 */
const getSchema = async (req, res) => {
  try {
    const bucket = req.query.bucket || null;
    const measurement = req.query.measurement || null;
    const schema = await influxService.getBucketSchema(bucket, measurement);
    return res.json({ success: true, data: schema });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * POST /api/influx/query
 * Execute read-only filtered Flux query
 */
const queryData = async (req, res) => {
  try {
    const queryOptions = req.body || {};
    const result = await influxService.queryInfluxData(queryOptions);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message
    });
  }
};

/**
 * POST /api/influx/export & GET /api/influx/export
 * Download queried data as CSV or JSON file
 */
const exportData = async (req, res) => {
  try {
    // Support parameters via POST body or GET query string
    const options = req.method === 'POST' ? req.body : {
      bucket: req.query.bucket,
      timeRange: req.query.timeRange,
      customStart: req.query.customStart,
      customStop: req.query.customStop,
      measurement: req.query.measurement,
      field: req.query.field,
      unit: req.query.unit,
      aggregation: req.query.aggregation,
      aggFn: req.query.aggFn,
      limit: req.query.limit ? Number(req.query.limit) : 5000,
      format: req.query.format || 'csv',
      rawFluxQuery: req.query.rawFluxQuery,
      tags: req.query.tags ? JSON.parse(req.query.tags) : {}
    };

    const format = (options.format || 'csv').toLowerCase();
    const result = await influxService.queryInfluxData({
      ...options,
      limit: options.limit || 10000 // Higher limit for export
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const bucketName = result.bucket || 'influx';
    const measName = options.measurement ? `_${options.measurement}` : '';

    if (format === 'json') {
      const filename = `influx_export_${bucketName}${measName}_${timestamp}.json`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.send(JSON.stringify(result.rows, null, 2));
    } else {
      // Default: CSV
      const csvString = influxService.convertRecordsToCsv(result.rows, result.tagKeys);
      const filename = `influx_export_${bucketName}${measName}_${timestamp}.csv`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(csvString);
    }
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.response?.data?.message || err.message
    });
  }
};

module.exports = {
  getHealth,
  getConfig,
  saveConfig,
  getBuckets,
  getSchema,
  queryData,
  exportData
};
