const axios = require('axios');
const db = require('./db');

// Default InfluxDB settings (can be overridden via environment variables or DB settings)
const DEFAULT_INFLUX_URL = process.env.INFLUX_URL;
const DEFAULT_INFLUX_TOKEN = process.env.INFLUX_TOKEN;
const DEFAULT_INFLUX_ORG = process.env.INFLUX_ORG;
const DEFAULT_INFLUX_BUCKET = process.env.INFLUX_DEFAULT_BUCKET;

/**
 * Get active InfluxDB configuration merged from DB settings and environment variables
 */
async function getInfluxConfig() {
  try {
    const rows = await db.all(
      "SELECT key, value FROM settings WHERE key IN ('influx_url', 'influx_token', 'influx_org', 'influx_bucket')"
    );
    const map = {};
    if (Array.isArray(rows)) {
      rows.forEach(r => {
        if (r.key && r.value) map[r.key] = r.value;
      });
    }

    return {
      url: (map.influx_url || process.env.INFLUX_URL || DEFAULT_INFLUX_URL).replace(/\/+$/, ''),
      token: map.influx_token || process.env.INFLUX_TOKEN || DEFAULT_INFLUX_TOKEN,
      org: map.influx_org || process.env.INFLUX_ORG || DEFAULT_INFLUX_ORG,
      bucket: map.influx_bucket || process.env.INFLUX_DEFAULT_BUCKET || DEFAULT_INFLUX_BUCKET
    };
  } catch (err) {
    return {
      url: DEFAULT_INFLUX_URL.replace(/\/+$/, ''),
      token: DEFAULT_INFLUX_TOKEN,
      org: DEFAULT_INFLUX_ORG,
      bucket: DEFAULT_INFLUX_BUCKET
    };
  }
}

/**
 * Save / Update InfluxDB configuration in settings table
 */
async function saveInfluxConfig({ url, token, org, bucket }) {
  const configs = [
    { key: 'influx_url', value: url ? url.trim() : '' },
    { key: 'influx_token', value: token ? token.trim() : '' },
    { key: 'influx_org', value: org ? org.trim() : '' },
    { key: 'influx_bucket', value: bucket ? bucket.trim() : '' }
  ];

  for (const item of configs) {
    if (item.value !== undefined) {
      await db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?) 
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [item.key, item.value]
      );
    }
  }

  return await getInfluxConfig();
}

/**
 * Test connectivity and token authorization to InfluxDB instance
 */
async function testConnection(customConfig = null) {
  const config = customConfig || (await getInfluxConfig());
  const startTime = Date.now();

  const result = {
    connected: false,
    authorized: false,
    latencyMs: 0,
    version: 'Unknown',
    url: config.url,
    org: config.org,
    bucket: config.bucket,
    error: null
  };

  // 1. Ping / Health check
  try {
    const pingRes = await axios.get(`${config.url}/ping`, { timeout: 4000 });
    result.connected = true;
    result.version = pingRes.headers['x-influxdb-version'] || pingRes.headers['x-influxdb-build'] || 'v2.x';
  } catch (pingErr) {
    try {
      const healthRes = await axios.get(`${config.url}/health`, { timeout: 4000 });
      result.connected = true;
      result.version = healthRes.data?.version || 'v2.x';
    } catch (healthErr) {
      result.error = `Gagal menghubungi host InfluxDB (${config.url}): ${healthErr.message}`;
      result.latencyMs = Date.now() - startTime;
      return result;
    }
  }

  // 2. Test Token & Org Authorization by fetching buckets list
  if (!config.token) {
    result.error = 'Token InfluxDB belum dikonfigurasi. Masukkan API Token untuk mengakses bucket.';
    result.latencyMs = Date.now() - startTime;
    return result;
  }

  try {
    const bucketsRes = await axios.get(`${config.url}/api/v2/buckets`, {
      headers: {
        Authorization: `Token ${config.token}`
      },
      params: config.org ? { org: config.org } : {},
      timeout: 5000
    });

    result.authorized = true;
    result.latencyMs = Date.now() - startTime;
    result.buckets = (bucketsRes.data?.buckets || []).map(b => ({
      id: b.id,
      name: b.name,
      retentionRules: b.retentionRules,
      createdAt: b.createdAt
    }));
    return result;
  } catch (authErr) {
    result.latencyMs = Date.now() - startTime;
    if (authErr.response?.status === 401) {
      result.error = 'Token InfluxDB tidak valid (Unauthorized). Periksa kembali Token Anda.';
    } else if (authErr.response?.status === 404 && config.org) {
      result.error = `Organisasi InfluxDB "${config.org}" tidak ditemukan (404).`;
    } else {
      result.error = `Gagal otentikasi InfluxDB: ${authErr.response?.data?.message || authErr.message}`;
    }
    return result;
  }
}

/**
 * Get list of accessible buckets
 */
async function getBuckets() {
  const config = await getInfluxConfig();
  if (!config.token) {
    throw new Error('InfluxDB Token belum dikonfigurasi. Atur token di menu Konfigurasi.');
  }

  const response = await axios.get(`${config.url}/api/v2/buckets`, {
    headers: {
      Authorization: `Token ${config.token}`
    },
    params: config.org ? { org: config.org } : {},
    timeout: 8000
  });

  return (response.data?.buckets || []).map(b => ({
    id: b.id,
    name: b.name,
    type: b.type,
    retentionRules: b.retentionRules,
    description: b.description || ''
  }));
}

/**
 * Parse InfluxDB Annotated CSV into standard JavaScript objects
 */
function parseAnnotatedCsv(csvString) {
  if (!csvString || typeof csvString !== 'string') return [];

  const lines = csvString.split(/\r?\n/);
  let headers = [];
  const records = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Ignore comment and metadata lines starting with '#'
    if (line.startsWith('#')) {
      continue;
    }

    // Header line (first non-# line)
    if (headers.length === 0) {
      headers = parseCsvLine(line);
      continue;
    }

    // Data line
    const values = parseCsvLine(line);
    if (values.length < headers.length) continue;

    const row = {};
    for (let h = 0; h < headers.length; h++) {
      const colName = headers[h];
      if (!colName) continue;
      row[colName] = values[h];
    }

    // Normalize record structure
    const cleanRow = {
      _time: row['_time'] || null,
      _measurement: row['_measurement'] || '',
      _field: row['_field'] || '',
      _value: parseNumericOrString(row['_value']),
      table: row['table'] !== undefined ? Number(row['table']) : 0
    };

    // Attach any dynamic tags (anything not starting with '_' and not standard system column)
    const systemCols = new Set(['', 'result', 'table', '_start', '_stop', '_time', '_value', '_field', '_measurement']);
    for (const [k, v] of Object.entries(row)) {
      if (!systemCols.has(k)) {
        cleanRow[k] = v;
      }
    }

    records.push(cleanRow);
  }

  return records;
}

/**
 * Helper to split CSV row handling quoted values safely
 */
function parseCsvLine(text) {
  const result = [];
  let curr = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') {
      if (inQuotes && text[i + 1] === '"') {
        curr += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === ',' && !inQuotes) {
      result.push(curr);
      curr = '';
    } else {
      curr += char;
    }
  }
  result.push(curr);
  return result;
}

function parseNumericOrString(val) {
  if (val === undefined || val === null || val === '') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = Number(val);
  return !isNaN(num) ? num : val;
}

/**
 * Execute raw Flux query via InfluxDB v2 REST API
 * STRICTLY READ-ONLY: Rejects any queries that might modify data
 */
async function executeFluxQuery(fluxQuery, dialect = null) {
  const config = await getInfluxConfig();
  if (!config.token) {
    throw new Error('InfluxDB Token belum dikonfigurasi.');
  }

  // Security guardrail: Disallow any write or drop attempts in query text
  const blockedKeywords = ['to(', 'experimental.to(', 'schema.drop', 'dropBucket', 'delete'];
  for (const kw of blockedKeywords) {
    if (fluxQuery.toLowerCase().includes(kw.toLowerCase())) {
      throw new Error(`Operasi terlarang: "${kw}" tidak diizinkan. Sistem ini murni Read-Only.`);
    }
  }

  const queryUrl = `${config.url}/api/v2/query${config.org ? `?org=${encodeURIComponent(config.org)}` : ''}`;

  const payload = {
    query: fluxQuery,
    type: 'flux',
    ...(dialect ? { dialect: typeof dialect === 'object' ? dialect : {
      annotations: ['group', 'datatype', 'default'],
      header: true,
      delimiter: ','
    } } : {})
  };

  const response = await axios.post(
    queryUrl,
    payload,
    {
      headers: {
        Authorization: `Token ${config.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/csv'
      },
      timeout: 45000,
      responseType: 'text'
    }
  );

  return response.data || '';
}

/**
 * Schema discovery: get measurements, fields, and tag keys/values for a given bucket
 */
async function getBucketSchema(bucketName = null, measurement = null) {
  const config = await getInfluxConfig();
  const targetBucket = bucketName || config.bucket;

  let measurements = [];
  let fields = [];
  let units = [];
  let tagKeys = [];

  // 1. Get measurements
  try {
    const measFlux = `
      import "influxdata/influxdb/schema"
      schema.measurements(bucket: "${targetBucket}")
    `;
    const csvRaw = await executeFluxQuery(measFlux);
    const parsed = parseAnnotatedCsv(csvRaw);
    measurements = parsed.map(r => r._value).filter(Boolean);
  } catch (err) {
    measurements = [];
  }

  // 2. If measurement specified, get field keys and tag keys
  let measurementList = [];
  if (Array.isArray(measurement)) {
    measurementList = measurement.map(m => String(m).trim()).filter(Boolean);
  } else if (measurement && typeof measurement === 'string') {
    measurementList = measurement.split(',').map(m => m.trim()).filter(Boolean);
  }

  if (measurementList.length > 0) {
    try {
      let fieldFlux = '';
      if (measurementList.length === 1) {
        fieldFlux = `
          import "influxdata/influxdb/schema"
          schema.fieldKeys(bucket: "${targetBucket}", predicate: (r) => r._measurement == "${measurementList[0]}")
        `;
      } else {
        const cond = measurementList.map(m => `r._measurement == "${m}"`).join(' or ');
        fieldFlux = `
          import "influxdata/influxdb/schema"
          schema.fieldKeys(bucket: "${targetBucket}", predicate: (r) => ${cond})
        `;
      }
      const csvRaw = await executeFluxQuery(fieldFlux);
      fields = parseAnnotatedCsv(csvRaw).map(r => r._value).filter(Boolean);
    } catch (_) {}

    try {
      let tagKeysFlux = '';
      if (measurementList.length === 1) {
        tagKeysFlux = `
          import "influxdata/influxdb/schema"
          schema.measurementTagKeys(bucket: "${targetBucket}", measurement: "${measurementList[0]}")
        `;
      } else {
        tagKeysFlux = `
          import "influxdata/influxdb/schema"
          schema.tagKeys(bucket: "${targetBucket}")
        `;
      }
      const csvRaw = await executeFluxQuery(tagKeysFlux);
      tagKeys = parseAnnotatedCsv(csvRaw)
        .map(r => r._value)
        .filter(k => k && !k.startsWith('_'));
    } catch (_) {}
  }

  // 3. Get distinct unit tag values (e.g. pod_31, pod_14)
  try {
    const unitFlux = `
      import "influxdata/influxdb/schema"
      schema.tagValues(bucket: "${targetBucket}", tag: "unit")
    `;
    const csvRaw = await executeFluxQuery(unitFlux);
    units = parseAnnotatedCsv(csvRaw).map(r => r._value).filter(Boolean);
  } catch (_) {}

  return {
    bucket: targetBucket,
    measurements: Array.from(new Set(measurements)),
    fields: Array.from(new Set(fields)),
    units: Array.from(new Set(units)),
    tagKeys: Array.from(new Set(tagKeys))
  };
}

/**
 * Helper to build Flux query matching the exact user pipeline structure:
 * from(bucket: "...")
 *   |> range(...)
 *   |> filter(fn: (r) => r["_measurement"] == "...")
 *   |> filter(fn: (r) => r["_field"] == "...")
 *   |> filter(fn: (r) => r["unit"] == "...")
 *   |> aggregateWindow(every: ..., fn: mean, createEmpty: false)
 *   |> yield(name: "...")
 */
function formatFluxTimeLiteral(val, isStop = false) {
  if (!val) return null;
  const s = String(val).trim();
  if (!s) return null;
  if (/^-\d+[smhdwmo]$/i.test(s) || s === 'now()') {
    return s;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const timeSuffix = isStop ? 'T23:59:59.999Z' : 'T00:00:00.000Z';
    return new Date(`${s}${timeSuffix}`).toISOString();
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) {
    return d.toISOString();
  }
  return s;
}

function buildFluxQuery(options = {}, defaultBucket = 'pod_monitoring') {
  const {
    bucket = defaultBucket,
    timeRange = '-1h',
    customStart = null,
    customStop = null,
    measurement = null,
    measurements = null,
    field = null,
    fields = null,
    unit = null,
    tags = {}, // { [tagKey]: tagValue }
    aggregation = 'none', // 'none' | '10s' | '1m' | '5m' | '15m' | '1h'
    aggFn = 'mean', // 'mean' | 'max' | 'min' | 'last'
    limit = 1000
  } = options;

  const lines = [];
  lines.push(`from(bucket: "${bucket || defaultBucket}")`);

  // Range
  if (customStart) {
    const cStart = formatFluxTimeLiteral(customStart, false);
    const cStop = customStop ? formatFluxTimeLiteral(customStop, true) : null;
    if (cStop) {
      lines.push(`  |> range(start: ${cStart}, stop: ${cStop})`);
    } else {
      lines.push(`  |> range(start: ${cStart})`);
    }
  } else {
    lines.push(`  |> range(start: ${timeRange || '-1h'})`);
  }

  // Filter Measurement (Supports single string or multiple measurements array)
  const rawMeasurements = measurements || measurement;
  const targetMeasurements = Array.isArray(rawMeasurements)
    ? rawMeasurements
    : (rawMeasurements ? [rawMeasurements] : []);

  const cleanMeasurements = targetMeasurements
    .map(m => String(m).trim())
    .filter(m => m.length > 0);

  if (cleanMeasurements.length === 1) {
    lines.push(`  |> filter(fn: (r) => r["_measurement"] == "${cleanMeasurements[0]}")`);
  } else if (cleanMeasurements.length > 1) {
    const measurementConditions = cleanMeasurements.map(m => `r["_measurement"] == "${m}"`).join(' or ');
    lines.push(`  |> filter(fn: (r) => ${measurementConditions})`);
  }

  // Filter Field (Supports single string or multiple fields array)
  const rawFields = fields || field;
  const targetFields = Array.isArray(rawFields)
    ? rawFields
    : (rawFields ? [rawFields] : []);

  const cleanFields = targetFields
    .map(f => String(f).trim())
    .filter(f => f.length > 0);

  if (cleanFields.length === 1) {
    lines.push(`  |> filter(fn: (r) => r["_field"] == "${cleanFields[0]}")`);
  } else if (cleanFields.length > 1) {
    const fieldConditions = cleanFields.map(f => `r["_field"] == "${f}"`).join(' or ');
    lines.push(`  |> filter(fn: (r) => ${fieldConditions})`);
  }

  // Filter Unit (e.g. pod_31)
  if (unit && String(unit).trim() !== '' && String(unit).trim() !== 'all') {
    lines.push(`  |> filter(fn: (r) => r["unit"] == "${String(unit).trim()}")`);
  }

  // Filter dynamic tags
  if (tags && typeof tags === 'object') {
    for (const [k, v] of Object.entries(tags)) {
      if (k === 'unit' && unit) continue;
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        lines.push(`  |> filter(fn: (r) => r["${k}"] == "${String(v).trim()}")`);
      }
    }
  }

  // Aggregation window & yield
  if (aggregation && aggregation !== 'none') {
    const validIntervals = ['10s', '30s', '1m', '5m', '10m', '15m', '30m', '1h'];
    const safeInterval = validIntervals.includes(aggregation) ? aggregation : '1m';
    const safeFn = ['mean', 'max', 'min', 'last', 'count'].includes(aggFn) ? aggFn : 'mean';
    lines.push(`  |> aggregateWindow(every: ${safeInterval}, fn: ${safeFn}, createEmpty: false)`);
    lines.push(`  |> yield(name: "${safeFn}")`);
  }

  // Limit
  if (limit && Number(limit) > 0) {
    const safeLimit = Math.min(Math.max(Number(limit), 1), 50000);
    lines.push(`  |> limit(n: ${safeLimit})`);
  }

  return lines.join('\n');
}

/**
 * Query InfluxDB data with dynamic filters or raw Flux query (Read-Only)
 */
async function queryInfluxData(options = {}) {
  const config = await getInfluxConfig();
  const startTime = Date.now();

  let fluxQuery = '';
  if (options.rawFluxQuery && typeof options.rawFluxQuery === 'string' && options.rawFluxQuery.trim()) {
    fluxQuery = options.rawFluxQuery.trim();
  } else {
    fluxQuery = buildFluxQuery(options, config.bucket);
  }

  const csvRaw = await executeFluxQuery(fluxQuery);
  const rows = parseAnnotatedCsv(csvRaw);
  const queryDurationMs = Date.now() - startTime;

  // Extract metadata (available tag columns, field names, total rows)
  const tagKeys = new Set();
  const fieldNames = new Set();
  const measurementsFound = new Set();

  rows.forEach(r => {
    if (r._measurement) measurementsFound.add(r._measurement);
    if (r._field) fieldNames.add(r._field);
    Object.keys(r).forEach(k => {
      if (!['_time', '_measurement', '_field', '_value', 'table'].includes(k)) {
        tagKeys.add(k);
      }
    });
  });

  return {
    success: true,
    totalRows: rows.length,
    queryDurationMs,
    bucket: options.bucket || config.bucket,
    measurements: Array.from(measurementsFound),
    fields: Array.from(fieldNames),
    tagKeys: Array.from(tagKeys),
    rows,
    fluxQuery
  };
}

/**
 * Convert structured JSON records into InfluxDB Annotated CSV format
 * Matches official InfluxDB specification:
 * #group,false,false,true,true,false,false,true,true,...
 * #datatype,string,long,dateTime:RFC3339,dateTime:RFC3339,dateTime:RFC3339,double,string,string,...
 * #default,_result,,,,,,,,...
 * ,result,table,_start,_stop,_time,_value,_field,_measurement,[tags...]
 */
function convertRecordsToAnnotatedCsv(records = [], tagKeys = []) {
  if (!tagKeys || tagKeys.length === 0) {
    const tagSet = new Set();
    records.forEach((r) => {
      Object.keys(r).forEach((k) => {
        if (!['_time', '_measurement', '_field', '_value', 'table', 'result', '_start', '_stop'].includes(k)) {
          tagSet.add(k);
        }
      });
    });
    tagKeys = Array.from(tagSet);
  }

  const groupCols = ['#group', 'false', 'false', 'true', 'true', 'false', 'false', 'true', 'true', ...tagKeys.map(() => 'true')];
  const datatypeCols = ['#datatype', 'string', 'long', 'dateTime:RFC3339', 'dateTime:RFC3339', 'dateTime:RFC3339', 'double', 'string', 'string', ...tagKeys.map(() => 'string')];
  const defaultCols = ['#default', '_result', ...new Array(groupCols.length - 2).fill('')];
  const headerCols = ['', 'result', 'table', '_start', '_stop', '_time', '_value', '_field', '_measurement', ...tagKeys];

  const lines = [
    groupCols.join(','),
    datatypeCols.join(','),
    defaultCols.join(','),
    headerCols.join(',')
  ];

  for (const r of records) {
    const row = [
      '',
      escapeCsvValue(r.result || ''),
      escapeCsvValue(r.table !== undefined ? r.table : 0),
      escapeCsvValue(r._start || ''),
      escapeCsvValue(r._stop || ''),
      escapeCsvValue(r._time || ''),
      escapeCsvValue(r._value !== undefined && r._value !== null ? r._value : ''),
      escapeCsvValue(r._field || ''),
      escapeCsvValue(r._measurement || ''),
      ...tagKeys.map((t) => escapeCsvValue(r[t]))
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

const convertRecordsToCsv = convertRecordsToAnnotatedCsv;

/**
 * Export query results in native InfluxDB Annotated CSV format
 */
async function exportAnnotatedCsv(options = {}) {
  const config = await getInfluxConfig();
  let fluxQuery = '';
  if (options.rawFluxQuery && typeof options.rawFluxQuery === 'string' && options.rawFluxQuery.trim()) {
    fluxQuery = options.rawFluxQuery.trim();
  } else {
    fluxQuery = buildFluxQuery({
      ...options,
      limit: options.limit || 50000
    }, options.bucket || config.bucket);
  }

  try {
    const csvRaw = await executeFluxQuery(fluxQuery, {
      annotations: ['group', 'datatype', 'default'],
      header: true,
      delimiter: ','
    });

    if (csvRaw && csvRaw.includes('#datatype')) {
      return csvRaw;
    }
  } catch (err) {
    console.warn('[influxService.exportAnnotatedCsv] Dialect export failed, falling back to converted records:', err.message);
  }

  const result = await queryInfluxData({ ...options, limit: options.limit || 50000 });
  return convertRecordsToAnnotatedCsv(result.rows || [], result.tagKeys || []);
}

module.exports = {
  getInfluxConfig,
  saveInfluxConfig,
  testConnection,
  getBuckets,
  getBucketSchema,
  buildFluxQuery,
  executeFluxQuery,
  queryInfluxData,
  convertRecordsToCsv,
  convertRecordsToAnnotatedCsv,
  exportAnnotatedCsv
};
