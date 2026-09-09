const axios = require('axios');
const http = require('http');
const db = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');

// Default fallback token (shared default across some PODs)
const DEFAULT_FALLBACK_TOKEN = 'CZtWSYvyTkfwGvaGffoDLEMJL0flUn10wkcn6gYuG3G3_ae666e6Y-DiaOHQ2zRgJdIQPSRVgnMt4skITBgzEQ==';
const TOKEN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 Hour TTL

// In-Memory caches
const tokenCache = new Map(); // podId -> { token, cachedAt, source }
const manualOverrideTokens = new Map(); // podId -> token

/**
 * Split CSV row handling quoted values safely
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

/**
 * Parse numeric, boolean or string values safely
 */
function parseNumericOrString(val) {
  if (val === undefined || val === null || val === '') return null;
  if (val === 'true') return true;
  if (val === 'false') return false;
  const num = Number(val);
  return !isNaN(num) && isFinite(num) ? num : val;
}

/**
 * Parse InfluxDB annotated CSV response into clean structured JSON records
 */
function parseAnnotatedCsv(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];

  const lines = csvText.split(/\r?\n/);
  const records = [];
  let headers = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // Line starting with # is annotation header
    if (line.startsWith('#')) {
      continue;
    }

    // First non-comment line or table header line containing column names
    if (headers.length === 0 || line.startsWith(',result,table') || line.includes('_time') || line.includes('_value')) {
      const cols = parseCsvLine(line);
      if (cols.includes('_value') || cols.includes('_time') || cols.includes('_field')) {
        headers = cols;
        continue;
      }
    }

    if (headers.length === 0) continue;

    const values = parseCsvLine(line);
    if (values.length < headers.length) continue;

    const row = {};
    for (let h = 0; h < headers.length; h++) {
      const colName = headers[h];
      if (!colName) continue;
      row[colName] = values[h];
    }

    const cleanRow = {
      _time: row['_time'] || null,
      _measurement: row['_measurement'] || '',
      _field: row['_field'] || '',
      _value: parseNumericOrString(row['_value']),
      table: row['table'] !== undefined ? Number(row['table']) : 0
    };

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
 * Validate that Flux query contains NO mutations (Read-Only guarantee)
 */
function validateReadOnlyFluxQuery(fluxQuery) {
  if (!fluxQuery || typeof fluxQuery !== 'string') {
    throw new Error('Query Flux tidak valid atau kosong.');
  }

  const forbiddenPatterns = [
    /\bto\s*\(/i,
    /\bexperimental\.to\s*\(/i,
    /\bdelete\b/i,
    /\bdrop\b/i,
    /\bcreate\b/i,
    /\balter\b/i,
    /\binsert\b/i,
    /\bwrite\b/i,
    /\bsocket\.from\s*\(/i,
    /\bhttp\.post\s*\(/i
  ];

  for (const pattern of forbiddenPatterns) {
    if (pattern.test(fluxQuery)) {
      throw new Error(
        `Akses Ditolak: Operasi mutasi atau tulis (${pattern.toString()}) dilarang! InfluxDB POD hanya mengizinkan operasi READ-ONLY.`
      );
    }
  }

  return true;
}

/**
 * Ping port 8086 quickly on a host
 */
function checkPortOpen(host, port = 8086, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: '/ping',
        method: 'GET',
        timeout: timeoutMs
      },
      (res) => {
        res.resume();
        resolve({
          open: true,
          statusCode: res.statusCode,
          version: res.headers['x-influxdb-version'] || res.headers['x-influxdb-build'] || 'v2.x'
        });
      }
    );

    req.on('timeout', () => {
      req.destroy();
      resolve({ open: false, error: 'Connection timed out' });
    });

    req.on('error', (err) => {
      resolve({ open: false, error: err.message });
    });

    req.end();
  });
}

/**
 * Retrieve server record from database
 */
async function getPodServer(podId) {
  const row = await db.get(
    `SELECT id, name, host, port, username, password, auth_type, private_key, pod_version, code 
     FROM servers WHERE id = ? AND LOWER(pod_version) = 'v3'`,
    [podId]
  );
  if (!row) {
    throw new Error(`POD V3 dengan ID ${podId} tidak ditemukan.`);
  }
  return row;
}

/**
 * Retrieve or fetch Influx token for a POD
 * Resolves in order:
 * 1. Manual user override
 * 2. In-memory cache (TTL 1 hour)
 * 3. SSH read /home/pod/influx_token.json
 * 4. Fallback default token
 */
async function getOrFetchPodToken(server, forceRefresh = false) {
  const podId = server.id;

  // 1. Check manual override
  if (manualOverrideTokens.has(podId)) {
    return {
      token: manualOverrideTokens.get(podId),
      source: 'manual_override',
      cachedAt: Date.now()
    };
  }

  // 2. Check in-memory cache
  if (!forceRefresh && tokenCache.has(podId)) {
    const cached = tokenCache.get(podId);
    if (Date.now() - cached.cachedAt < TOKEN_CACHE_TTL_MS) {
      return cached;
    }
  }

  // 3. Try reading /home/pod/influx_token.json via SSH
  try {
    const stdout = await executeSshCommand(server, 'cat /home/pod/influx_token.json', {
      timeoutMs: 6000,
      readyTimeoutMs: 5000
    });

    if (stdout && stdout.trim()) {
      const parsed = JSON.parse(stdout.trim());
      if (parsed.token && typeof parsed.token === 'string' && parsed.token.trim().length > 10) {
        const tokenData = {
          token: parsed.token.trim(),
          source: '/home/pod/influx_token.json',
          cachedAt: Date.now()
        };
        tokenCache.set(podId, tokenData);
        return tokenData;
      }
    }
  } catch (sshErr) {
    console.warn(`[podInfluxService] SSH token fetch failed for POD ${server.id} (${server.name}):`, sshErr.message);
  }

  // 4. Fallback default token
  const fallbackData = {
    token: DEFAULT_FALLBACK_TOKEN,
    source: 'default_fallback',
    cachedAt: Date.now(),
    isFallback: true
  };
  tokenCache.set(podId, fallbackData);
  return fallbackData;
}

/**
 * List all POD V3 servers with Influx status & token info
 */
async function listPodServers() {
  const rows = await db.all(
    `SELECT id, name, host, port, code, pod_version 
     FROM servers 
     WHERE LOWER(pod_version) = 'v3' 
     ORDER BY code ASC, name ASC`
  );

  const results = await Promise.all(
    rows.map(async (pod) => {
      const cached = tokenCache.get(pod.id);
      const hasOverride = manualOverrideTokens.has(pod.id);
      const portStatus = await checkPortOpen(pod.host, 8086, 2000);

      return {
        id: pod.id,
        name: pod.name,
        host: pod.host,
        influxPort: 8086,
        code: pod.code,
        podVersion: pod.pod_version,
        isOnline: portStatus.open,
        influxVersion: portStatus.version || null,
        tokenStatus: hasOverride
          ? 'manual_override'
          : cached
          ? cached.source === 'default_fallback'
            ? 'fallback'
            : 'auto_file'
          : 'unknown',
        tokenSource: hasOverride
          ? 'Manual Input Override'
          : cached?.source || 'Belum dimuat (Auto saat query)',
        hasCachedToken: Boolean(cached?.token || hasOverride)
      };
    })
  );

  return results;
}

/**
 * Force refresh token or set manual override for a POD
 */
async function refreshPodToken(podId, overrideToken = null) {
  const server = await getPodServer(podId);

  if (overrideToken && typeof overrideToken === 'string' && overrideToken.trim()) {
    manualOverrideTokens.set(podId, overrideToken.trim());
    tokenCache.delete(podId);
  } else {
    manualOverrideTokens.delete(podId);
    tokenCache.delete(podId);
  }

  const tokenData = await getOrFetchPodToken(server, true);

  // Validate token against InfluxDB on POD
  let testResult = { authorized: false, error: null };
  try {
    const res = await axios.get(`http://${server.host}:8086/api/v2/buckets`, {
      headers: { Authorization: `Token ${tokenData.token}` },
      timeout: 4000
    });
    testResult.authorized = true;
    testResult.bucketsCount = res.data?.buckets?.length || 0;
  } catch (err) {
    testResult.error = err.response?.data?.message || err.message;
  }

  return {
    podId,
    name: server.name,
    host: server.host,
    tokenSource: tokenData.source,
    isFallback: tokenData.isFallback || false,
    testResult
  };
}

/**
 * Health check on a specific POD's Influx instance
 */
async function checkPodInfluxHealth(podId) {
  const server = await getPodServer(podId);
  const startTime = Date.now();

  const pingResult = await checkPortOpen(server.host, 8086, 3000);
  const tokenData = await getOrFetchPodToken(server);

  const health = {
    podId: server.id,
    name: server.name,
    host: server.host,
    influxUrl: `http://${server.host}:8086`,
    portOpen: pingResult.open,
    latencyMs: Date.now() - startTime,
    version: pingResult.version || null,
    tokenSource: tokenData.source,
    isFallback: tokenData.isFallback || false,
    authorized: false,
    buckets: [],
    error: pingResult.error || null
  };

  if (pingResult.open) {
    try {
      const res = await axios.get(`http://${server.host}:8086/api/v2/buckets`, {
        headers: { Authorization: `Token ${tokenData.token}` },
        timeout: 4000
      });
      health.authorized = true;
      health.buckets = (res.data?.buckets || []).map((b) => ({
        id: b.id,
        name: b.name,
        type: b.type
      }));
    } catch (authErr) {
      health.authorized = false;
      health.error = `Token tidak valid untuk ${server.name}: ${authErr.response?.data?.message || authErr.message}`;
    }
  }

  return health;
}

/**
 * Execute raw Flux query directly against a POD's InfluxDB (Read-Only)
 */
async function executeFluxQueryOnPod(podId, fluxQuery) {
  validateReadOnlyFluxQuery(fluxQuery);
  const server = await getPodServer(podId);
  const tokenData = await getOrFetchPodToken(server);

  const url = `http://${server.host}:8086/api/v2/query?org=pod`;

  try {
    const response = await axios.post(url, fluxQuery, {
      headers: {
        Authorization: `Token ${tokenData.token}`,
        'Content-Type': 'application/vnd.flux',
        Accept: 'application/csv'
      },
      timeout: 15000,
      responseType: 'text'
    });

    return response.data || '';
  } catch (err) {
    const errorMsg =
      err.response?.data ||
      err.response?.data?.message ||
      err.message ||
      'Terjadi kesalahan saat mengeksekusi query di Influx POD.';
    throw new Error(`[POD ${server.name} Influx Error]: ${errorMsg}`);
  }
}

/**
 * Get buckets directly from a POD
 */
async function getPodBuckets(podId) {
  const server = await getPodServer(podId);
  const tokenData = await getOrFetchPodToken(server);

  try {
    const res = await axios.get(`http://${server.host}:8086/api/v2/buckets`, {
      headers: { Authorization: `Token ${tokenData.token}` },
      timeout: 5000
    });

    return (res.data?.buckets || []).map((b) => ({
      id: b.id,
      name: b.name,
      type: b.type,
      description: b.description || '',
      retentionRules: b.retentionRules || []
    }));
  } catch (err) {
    throw new Error(
      `Gagal mengambil daftar bucket dari POD ${server.name} (${server.host}): ${
        err.response?.data?.message || err.message
      }`
    );
  }
}

/**
 * Get schema (measurements, field keys, units) for a bucket in a POD
 */
async function getPodSchema(podId, bucketName = 'pod_monitoring', measurement = null) {
  let measurements = [];
  let fields = [];
  let units = [];
  let tagKeys = [];

  // 1. Measurements
  try {
    const fluxMeasurements = `
      import "influxdata/influxdb/schema"
      schema.measurements(bucket: "${bucketName}")
    `;
    const csvRaw = await executeFluxQueryOnPod(podId, fluxMeasurements);
    measurements = parseAnnotatedCsv(csvRaw)
      .map((r) => r._value)
      .filter(Boolean);
  } catch (err) {
    console.warn(`[podInfluxService] Measurements schema failed on POD ${podId}:`, err.message);
  }

  // 2. Field Keys
  try {
    let measurementList = [];
    if (Array.isArray(measurement)) {
      measurementList = measurement.map(m => String(m).trim()).filter(Boolean);
    } else if (measurement && typeof measurement === 'string') {
      measurementList = measurement.split(',').map(m => m.trim()).filter(Boolean);
    }

    let fluxFields = '';
    if (measurementList.length === 1) {
      fluxFields = `
        import "influxdata/influxdb/schema"
        schema.fieldKeys(bucket: "${bucketName}", predicate: (r) => r._measurement == "${measurementList[0]}")
      `;
    } else if (measurementList.length > 1) {
      const cond = measurementList.map(m => `r._measurement == "${m}"`).join(' or ');
      fluxFields = `
        import "influxdata/influxdb/schema"
        schema.fieldKeys(bucket: "${bucketName}", predicate: (r) => ${cond})
      `;
    } else {
      fluxFields = `
        import "influxdata/influxdb/schema"
        schema.fieldKeys(bucket: "${bucketName}")
      `;
    }
    const csvRaw = await executeFluxQueryOnPod(podId, fluxFields);
    fields = parseAnnotatedCsv(csvRaw)
      .map((r) => r._value)
      .filter(Boolean);
  } catch (err) {
    console.warn(`[podInfluxService] Fields schema failed on POD ${podId}:`, err.message);
  }

  // 3. Tag Keys
  try {
    const fluxTagKeys = `
      import "influxdata/influxdb/schema"
      schema.tagKeys(bucket: "${bucketName}")
    `;
    const csvRaw = await executeFluxQueryOnPod(podId, fluxTagKeys);
    tagKeys = parseAnnotatedCsv(csvRaw)
      .map((r) => r._value)
      .filter((k) => k && !k.startsWith('_') && k !== 'result' && k !== 'table');
  } catch (_) {}

  // 4. Tag Values for 'unit'
  try {
    const fluxUnits = `
      import "influxdata/influxdb/schema"
      schema.tagValues(bucket: "${bucketName}", tag: "unit")
    `;
    const csvRaw = await executeFluxQueryOnPod(podId, fluxUnits);
    units = parseAnnotatedCsv(csvRaw)
      .map((r) => r._value)
      .filter(Boolean);
  } catch (_) {}

  return {
    podId,
    bucket: bucketName,
    measurements: Array.from(new Set(measurements)),
    fields: Array.from(new Set(fields)),
    units: Array.from(new Set(units)),
    tagKeys: Array.from(new Set(tagKeys))
  };
}

/**
 * Build clean Flux query matching user requirements
 */
function buildPodFluxQuery(options = {}, defaultBucket = 'pod_monitoring') {
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
    tags = {},
    aggregation = 'none',
    aggFn = 'mean',
    limit = 1000
  } = options;

  const lines = [];
  lines.push(`from(bucket: "${bucket || defaultBucket}")`);

  // Range
  if (customStart) {
    if (customStop) {
      lines.push(`  |> range(start: ${customStart}, stop: ${customStop})`);
    } else {
      lines.push(`  |> range(start: ${customStart})`);
    }
  } else {
    lines.push(`  |> range(start: ${timeRange || '-1h'})`);
  }

  // Measurement (Supports single string or multiple measurements array)
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

  // Field (Supports single string or multiple fields array)
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

  // Unit
  if (unit && String(unit).trim() !== '' && String(unit).trim() !== 'all') {
    lines.push(`  |> filter(fn: (r) => r["unit"] == "${String(unit).trim()}")`);
  }

  // Dynamic tags
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
    const safeFn = ['mean', 'max', 'min', 'last', 'count', 'sum'].includes(aggFn) ? aggFn : 'mean';
    lines.push(`  |> aggregateWindow(every: ${safeInterval}, fn: ${safeFn}, createEmpty: false)`);
    lines.push(`  |> yield(name: "${safeFn}")`);
  }

  // Limit
  if (limit && Number(limit) > 0) {
    const safeLimit = Math.min(Math.max(Number(limit), 1), 25000);
    lines.push(`  |> limit(n: ${safeLimit})`);
  }

  return lines.join('\n');
}

/**
 * Query data on a specific POD (Read-Only)
 */
async function queryPodData(podId, options = {}) {
  const server = await getPodServer(podId);
  const startTime = Date.now();

  let fluxQuery = '';
  if (options.rawFluxQuery && typeof options.rawFluxQuery === 'string' && options.rawFluxQuery.trim()) {
    fluxQuery = options.rawFluxQuery.trim();
  } else {
    fluxQuery = buildPodFluxQuery(options, options.bucket || 'pod_monitoring');
  }

  const csvRaw = await executeFluxQueryOnPod(podId, fluxQuery);
  const rows = parseAnnotatedCsv(csvRaw);
  const queryDurationMs = Date.now() - startTime;

  const tagKeys = new Set();
  const fieldNames = new Set();
  const measurementsFound = new Set();

  rows.forEach((r) => {
    if (r._measurement) measurementsFound.add(r._measurement);
    if (r._field) fieldNames.add(r._field);
    Object.keys(r).forEach((k) => {
      if (!['_time', '_measurement', '_field', '_value', 'table'].includes(k)) {
        tagKeys.add(k);
      }
    });
  });

  return {
    pod: {
      id: server.id,
      name: server.name,
      host: server.host,
      code: server.code
    },
    totalRecords: rows.length,
    queryDurationMs,
    fluxQuery,
    schemaFound: {
      measurements: Array.from(measurementsFound),
      fields: Array.from(fieldNames),
      tags: Array.from(tagKeys)
    },
    data: rows
  };
}

/**
 * Export data from POD to CSV or JSON
 */
async function exportPodData(podId, options = {}, format = 'csv') {
  const server = await getPodServer(podId);
  const result = await queryPodData(podId, {
    ...options,
    limit: options.limit || 50000
  });

  const records = result.data || [];
  const safePodName = (server.name || `POD_${podId}`).replace(/[^a-zA-Z0-9_-]/g, '_');
  const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const fileName = `influx_pod_${safePodName}_${timestampStr}.${format === 'json' ? 'json' : 'csv'}`;

  if (format === 'json') {
    return {
      fileName,
      contentType: 'application/json',
      content: JSON.stringify(
        {
          meta: {
            podId: server.id,
            podName: server.name,
            host: server.host,
            exportedAt: new Date().toISOString(),
            totalRecords: records.length,
            fluxQuery: result.fluxQuery
          },
          data: records
        },
        null,
        2
      )
    };
  }

  // Format as CSV
  const dynamicTagKeys = new Set();
  records.forEach((r) => {
    Object.keys(r).forEach((k) => {
      if (!['_time', '_measurement', '_field', '_value', 'table'].includes(k)) {
        dynamicTagKeys.add(k);
      }
    });
  });
  const tagList = Array.from(dynamicTagKeys);
  const headers = ['time', 'measurement', 'field', 'value', ...tagList];

  const escapeCsv = (str) => {
    if (str === null || str === undefined) return '';
    const s = String(str);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };

  const csvLines = [];
  csvLines.push(headers.join(','));

  for (const r of records) {
    const row = [
      escapeCsv(r._time),
      escapeCsv(r._measurement),
      escapeCsv(r._field),
      escapeCsv(r._value),
      ...tagList.map((tag) => escapeCsv(r[tag]))
    ];
    csvLines.push(row.join(','));
  }

  return {
    fileName,
    contentType: 'text/csv',
    content: csvLines.join('\n')
  };
}

let isTemplatesTableInitialized = false;

/**
 * Initialize influx_query_templates table and seed default templates if empty (runs once)
 */
async function initTemplatesTable() {
  if (isTemplatesTableInitialized) return;

  await db.exec(`
    CREATE TABLE IF NOT EXISTS influx_query_templates (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      category VARCHAR(100) DEFAULT 'General',
      is_raw_flux BOOLEAN DEFAULT FALSE,
      raw_flux_query TEXT,
      config JSONB,
      created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const countRow = await db.get('SELECT COUNT(*) as count FROM influx_query_templates');
  if (Number(countRow?.count || 0) === 0) {
    const starterTemplates = [
      {
        name: 'Suhu Kursi POD (Chair Temperature)',
        description: 'Monitoring suhu kursi pada unit POD V3 dengan agregasi 1 menit',
        category: 'Sensor Hardware',
        is_raw_flux: false,
        raw_flux_query: null,
        config: JSON.stringify({
          bucket: 'pod_monitoring',
          measurement: 'mod_chair',
          field: 'chair_temp',
          unit: 'all',
          timeRange: '-1h',
          aggregation: '1m',
          aggFn: 'mean',
          limit: 1000
        })
      },
      {
        name: 'Kelembaban Kursi POD (Chair Humidity)',
        description: 'Monitoring kelembaban kursi POD V3 secara real-time',
        category: 'Sensor Hardware',
        is_raw_flux: false,
        raw_flux_query: null,
        config: JSON.stringify({
          bucket: 'pod_monitoring',
          measurement: 'mod_chair',
          field: 'chair_hum',
          unit: 'all',
          timeRange: '-1h',
          aggregation: '1m',
          aggFn: 'mean',
          limit: 1000
        })
      },
      {
        name: 'Konsumsi Daya Listrik (Active Power)',
        description: 'Pantau pemakaian watt listrik pada bucket power_monitoring',
        category: 'Kelistrikan',
        is_raw_flux: false,
        raw_flux_query: null,
        config: JSON.stringify({
          bucket: 'power_monitoring',
          measurement: 'power_monitoring',
          field: 'active_power',
          unit: 'all',
          timeRange: '-2h',
          aggregation: '1m',
          aggFn: 'mean',
          limit: 1000
        })
      },
      {
        name: 'Heartbeat Services Status',
        description: 'Pemeriksaan status heartbeat modul software POD',
        category: 'Sistem & Heartbeat',
        is_raw_flux: false,
        raw_flux_query: null,
        config: JSON.stringify({
          bucket: 'pod_monitoring',
          measurement: 'hb_service',
          field: 'chair_temp',
          unit: 'all',
          timeRange: '-6h',
          aggregation: '5m',
          aggFn: 'mean',
          limit: 1000
        })
      }
    ];

    for (const t of starterTemplates) {
      await db.run(
        `INSERT INTO influx_query_templates (name, description, category, is_raw_flux, raw_flux_query, config)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [t.name, t.description, t.category, t.is_raw_flux, t.raw_flux_query, t.config]
      );
    }
  }

  isTemplatesTableInitialized = true;
}

// Auto-run init at startup
initTemplatesTable().catch(err => console.warn('[podInfluxService] initTemplatesTable warning:', err.message));

/**
 * Get list of all query templates
 */
async function getQueryTemplates() {
  await initTemplatesTable();
  const rows = await db.all(
    `SELECT id, name, description, category, is_raw_flux, raw_flux_query, config, created_at, updated_at 
     FROM influx_query_templates 
     ORDER BY category ASC, id DESC`
  );
  return rows.map(r => ({
    ...r,
    config: typeof r.config === 'string' ? JSON.parse(r.config) : (r.config || {})
  }));
}

/**
 * Create a new query template
 */
async function createQueryTemplate({ name, description = '', category = 'General', isRawFlux = false, rawFluxQuery = null, config = {} }) {
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Nama template wajib diisi.');
  }

  if (isRawFlux && rawFluxQuery) {
    validateReadOnlyFluxQuery(rawFluxQuery);
  }

  await initTemplatesTable();
  const configJson = typeof config === 'string' ? config : JSON.stringify(config || {});
  const res = await db.run(
    `INSERT INTO influx_query_templates (name, description, category, is_raw_flux, raw_flux_query, config)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name.trim(), description ? description.trim() : '', category ? category.trim() : 'General', Boolean(isRawFlux), rawFluxQuery || null, configJson]
  );

  const inserted = await db.get(`SELECT * FROM influx_query_templates WHERE id = ?`, [res.lastInsertRowid]);
  return {
    ...inserted,
    config: typeof inserted?.config === 'string' ? JSON.parse(inserted.config) : (inserted?.config || {})
  };
}

/**
 * Update an existing query template
 */
async function updateQueryTemplate(id, data = {}) {
  const numericId = Number(id);
  if (!numericId || isNaN(numericId)) {
    throw new Error('ID template tidak valid.');
  }

  const existing = await db.get(`SELECT * FROM influx_query_templates WHERE id = ?`, [numericId]);
  if (!existing) {
    throw new Error(`Template dengan ID ${numericId} tidak ditemukan.`);
  }

  const { name, description, category, isRawFlux, rawFluxQuery, config } = data;

  if (isRawFlux && rawFluxQuery) {
    validateReadOnlyFluxQuery(rawFluxQuery);
  }

  const updatedName = name !== undefined ? name.trim() : existing.name;
  const updatedDesc = description !== undefined ? description : existing.description;
  const updatedCat = category !== undefined ? category : existing.category;
  const updatedIsRaw = isRawFlux !== undefined ? Boolean(isRawFlux) : existing.is_raw_flux;
  const updatedRawFlux = rawFluxQuery !== undefined ? rawFluxQuery : existing.raw_flux_query;
  const updatedConfig = config !== undefined ? (typeof config === 'string' ? config : JSON.stringify(config)) : existing.config;

  await db.run(
    `UPDATE influx_query_templates 
     SET name = ?, description = ?, category = ?, is_raw_flux = ?, raw_flux_query = ?, config = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [updatedName, updatedDesc, updatedCat, updatedIsRaw, updatedRawFlux, updatedConfig, numericId]
  );

  const updated = await db.get(`SELECT * FROM influx_query_templates WHERE id = ?`, [numericId]);
  return {
    ...updated,
    config: typeof updated?.config === 'string' ? JSON.parse(updated.config) : (updated?.config || {})
  };
}

/**
 * Delete a query template
 */
async function deleteQueryTemplate(id) {
  const numericId = Number(id);
  if (!numericId || isNaN(numericId)) {
    throw new Error('ID template tidak valid.');
  }

  const existing = await db.get(`SELECT id, name FROM influx_query_templates WHERE id = ?`, [numericId]);
  if (!existing) {
    throw new Error(`Template dengan ID ${numericId} tidak ditemukan.`);
  }

  await db.run(`DELETE FROM influx_query_templates WHERE id = ?`, [numericId]);
  return { id: numericId, name: existing.name };
}

module.exports = {
  listPodServers,
  getOrFetchPodToken,
  refreshPodToken,
  checkPodInfluxHealth,
  executeFluxQueryOnPod,
  getPodBuckets,
  getPodSchema,
  queryPodData,
  exportPodData,
  validateReadOnlyFluxQuery,
  buildPodFluxQuery,
  getQueryTemplates,
  createQueryTemplate,
  updateQueryTemplate,
  deleteQueryTemplate
};

