const axios = require('axios');

// Default InfluxDB settings from environment
const INFLUX_URL = (process.env.INFLUX_URL || 'http://10.20.10.3:8086').replace(/\/+$/, '');
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'vV_n_nxn30wFNrhTuXtQo2lJTxnVqmAxXC0QHEvh8gMt2lOJJ5yMzQe7jWRdAAhiNzIxYkCaGXH_6c14wNX4Ew==';
const INFLUX_ORG = process.env.INFLUX_ORG || 'pod';
const INFLUX_BUCKET = process.env.INFLUX_LOGS_BUCKET || process.env.INFLUX_EVENTS_BUCKET || 'pod_logs_bhar';

// Write buffer for batching log points
let writeBuffer = [];
let flushTimeout = null;
const MAX_BUFFER_SIZE = 100;
const FLUSH_INTERVAL_MS = 1000;

/**
 * Escape Tag Key or Tag Value for InfluxDB Line Protocol
 * Commas, equal signs, and spaces must be escaped with a backslash.
 */
function escapeTag(val) {
  if (val === null || val === undefined) return '';
  return String(val)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/=/g, '\\=')
    .replace(/ /g, '\\ ');
}

/**
 * Escape Field String Value for InfluxDB Line Protocol
 * String values must be double-quoted, internal quotes and backslashes escaped.
 */
function escapeStringField(val) {
  if (val === null || val === undefined) return '""';
  const str = String(val)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${str}"`;
}

/**
 * Convert a pod event object into InfluxDB Line Protocol string
 * @param {Object} event
 * { id, podId, podName, moduleId, moduleName, eventType, message, lastHb, downtimeSeconds, rootCauseCategory, diagnosticHint, pingMs, timestamp }
 */
function formatEventToLineProtocol(event) {
  if (!event || !event.podId) return null;

  const measurement = 'pod_events';

  // Tags (Indexed for high-speed filtering)
  const tags = [];
  tags.push(`pod_id=${escapeTag(event.podId)}`);
  if (event.podName) tags.push(`pod_name=${escapeTag(event.podName)}`);
  if (event.eventType) tags.push(`event_type=${escapeTag(event.eventType)}`);
  if (event.moduleId !== null && event.moduleId !== undefined) {
    tags.push(`module_id=${escapeTag(event.moduleId)}`);
  } else {
    tags.push(`module_id=all`);
  }
  if (event.rootCauseCategory) {
    tags.push(`root_cause=${escapeTag(event.rootCauseCategory)}`);
  }

  // Fields (Data payload)
  const fields = [];
  if (event.id) fields.push(`event_id=${escapeStringField(event.id)}`);
  if (event.message) fields.push(`message=${escapeStringField(event.message)}`);
  if (event.moduleName) fields.push(`module_name=${escapeStringField(event.moduleName)}`);
  if (event.diagnosticHint) fields.push(`diagnostic_hint=${escapeStringField(event.diagnosticHint)}`);

  // Numeric fields
  if (event.downtimeSeconds !== null && event.downtimeSeconds !== undefined && !isNaN(Number(event.downtimeSeconds))) {
    fields.push(`downtime_seconds=${Math.round(Number(event.downtimeSeconds))}i`);
  }
  if (event.lastHb !== null && event.lastHb !== undefined && !isNaN(Number(event.lastHb))) {
    fields.push(`last_hb=${Math.round(Number(event.lastHb))}i`);
  }
  if (event.pingMs !== null && event.pingMs !== undefined && !isNaN(Number(event.pingMs))) {
    fields.push(`ping_ms=${Number(event.pingMs).toFixed(2)}`);
  }

  // Fallback field if no other fields exist
  if (fields.length === 0) {
    fields.push(`recorded=1i`);
  }

  // Timestamp in nanoseconds (InfluxDB Line Protocol default precision)
  const rawMs = typeof event.timestamp === 'number'
    ? event.timestamp
    : (new Date(event.timestamp || Date.now()).getTime() || Date.now());
  const nsStr = `${rawMs}000000`;

  return `${measurement},${tags.join(',')} ${fields.join(',')} ${nsStr}`;
}

/**
 * Convert a raw heartbeat / telemetry tick into InfluxDB Line Protocol string
 * @param {Object} tick { podId, serverName, moduleId, hb, port, payload, timestamp }
 */
function formatHeartbeatTickToLineProtocol(tick) {
  if (!tick || !tick.podId || !tick.moduleId) return null;

  const measurement = 'pod_heartbeat_logs';

  const tags = [];
  tags.push(`pod_id=${escapeTag(tick.podId)}`);
  tags.push(`unit=pod_${escapeTag(tick.podId)}`);
  if (tick.serverName) tags.push(`pod_name=${escapeTag(tick.serverName)}`);
  tags.push(`module_id=${escapeTag(tick.moduleId)}`);
  if (tick.port) tags.push(`port=${escapeTag(tick.port)}`);

  const fields = [];
  if (tick.hb !== null && tick.hb !== undefined && !isNaN(Number(tick.hb))) {
    fields.push(`hb=${Math.round(Number(tick.hb))}i`);
  }

  // Payload extraction (current, temp, humi, pob_state)
  const payload = tick.payload;
  if (payload && typeof payload === 'object') {
    if (payload.current !== undefined && payload.current !== null && !isNaN(Number(payload.current))) {
      fields.push(`current=${Number(payload.current).toFixed(2)}`);
    }
    if (payload.temp !== undefined && payload.temp !== null && !isNaN(Number(payload.temp))) {
      fields.push(`temp=${Number(payload.temp).toFixed(2)}`);
    }
    if (payload.humi !== undefined && payload.humi !== null && !isNaN(Number(payload.humi))) {
      fields.push(`humi=${Number(payload.humi).toFixed(2)}`);
    }
    if (payload.pob_state !== undefined && payload.pob_state !== null && !isNaN(Number(payload.pob_state))) {
      fields.push(`pob_state=${Math.round(Number(payload.pob_state))}i`);
    }
  }

  // Direct fields support
  if (tick.current !== undefined && tick.current !== null && !isNaN(Number(tick.current))) {
    fields.push(`current=${Number(tick.current).toFixed(2)}`);
  }

  if (fields.length === 0) {
    fields.push(`recorded=1i`);
  }

  const rawMs = typeof tick.timestamp === 'number'
    ? tick.timestamp
    : (new Date(tick.timestamp || Date.now()).getTime() || Date.now());
  const nsStr = `${rawMs}000000`;

  return `${measurement},${tags.join(',')} ${fields.join(',')} ${nsStr}`;
}

/**
 * Convert a pod state snapshot into InfluxDB Line Protocol string
 */
function formatPodStateToLineProtocol(podId, stateData) {
  if (!podId || !stateData) return null;

  const measurement = 'pod_state';
  const tags = [];
  tags.push(`pod_id=${escapeTag(podId)}`);
  tags.push(`unit=pod_${escapeTag(podId)}`);
  if (stateData.name) tags.push(`pod_name=${escapeTag(stateData.name)}`);

  const fields = [];
  const statusStr = stateData.status || (stateData.isDead ? 'DEAD' : (stateData.isFrozen ? 'FROZEN' : 'ALIVE'));
  fields.push(`status=${escapeStringField(statusStr)}`);

  if (stateData.activeModules && Array.isArray(stateData.activeModules)) {
    fields.push(`active_modules_count=${stateData.activeModules.length}i`);
  }
  if (stateData.deadModulesCount !== undefined && !isNaN(Number(stateData.deadModulesCount))) {
    fields.push(`dead_modules_count=${Math.round(Number(stateData.deadModulesCount))}i`);
  }
  if (stateData.updatedAt) {
    fields.push(`updated_at=${escapeStringField(stateData.updatedAt)}`);
  }

  const nsStr = `${Date.now()}000000`;
  return `${measurement},${tags.join(',')} ${fields.join(',')} ${nsStr}`;
}

/**
 * Flush write buffer to InfluxDB bucket
 */
async function flushBuffer() {
  if (flushTimeout) {
    clearTimeout(flushTimeout);
    flushTimeout = null;
  }

  if (writeBuffer.length === 0) return;

  const pointsToSend = [...writeBuffer];
  writeBuffer = [];

  const body = pointsToSend.join('\n');
  const writeUrl = `${INFLUX_URL}/api/v2/write?org=${encodeURIComponent(INFLUX_ORG)}&bucket=${encodeURIComponent(INFLUX_BUCKET)}&precision=ns`;

  try {
    const res = await axios.post(writeUrl, body, {
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'text/plain; charset=utf-8'
      },
      timeout: 5000
    });

    if (res.status !== 204 && res.status !== 200) {
      console.warn(`[InfluxEventWriter] Unexpected status ${res.status} when writing ${pointsToSend.length} points.`);
    }
  } catch (err) {
    console.warn(`[InfluxEventWriter] Failed to write ${pointsToSend.length} points to InfluxDB (${INFLUX_BUCKET}):`, err.message);
  }
}

/**
 * Queue a pod event for writing to InfluxDB
 */
function writePodEvent(eventObj) {
  try {
    const line = formatEventToLineProtocol(eventObj);
    if (!line) return;

    writeBuffer.push(line);

    if (writeBuffer.length >= MAX_BUFFER_SIZE) {
      flushBuffer().catch(() => {});
    } else if (!flushTimeout) {
      flushTimeout = setTimeout(() => {
        flushBuffer().catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    console.warn('[InfluxEventWriter] Error formatting event line:', err.message);
  }
}

/**
 * Queue a raw heartbeat tick for writing to InfluxDB (pod_heartbeat_logs)
 */
function writePodHeartbeatTick(tickObj) {
  try {
    const line = formatHeartbeatTickToLineProtocol(tickObj);
    if (!line) return;

    writeBuffer.push(line);

    if (writeBuffer.length >= MAX_BUFFER_SIZE) {
      flushBuffer().catch(() => {});
    } else if (!flushTimeout) {
      flushTimeout = setTimeout(() => {
        flushBuffer().catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    console.warn('[InfluxEventWriter] Error formatting heartbeat tick line:', err.message);
  }
}

/**
 * Queue a pod state snapshot for writing to InfluxDB (pod_state)
 */
function writePodState(podId, stateData) {
  try {
    const line = formatPodStateToLineProtocol(podId, stateData);
    if (!line) return;

    writeBuffer.push(line);

    if (writeBuffer.length >= MAX_BUFFER_SIZE) {
      flushBuffer().catch(() => {});
    } else if (!flushTimeout) {
      flushTimeout = setTimeout(() => {
        flushBuffer().catch(() => {});
      }, FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    console.warn('[InfluxEventWriter] Error formatting pod state line:', err.message);
  }
}

/**
 * Write a single event immediately and await completion (useful for testing or critical events)
 */
async function writePodEventImmediate(eventObj) {
  const line = formatEventToLineProtocol(eventObj);
  if (!line) return false;

  const writeUrl = `${INFLUX_URL}/api/v2/write?org=${encodeURIComponent(INFLUX_ORG)}&bucket=${encodeURIComponent(INFLUX_BUCKET)}&precision=ns`;
  try {
    const res = await axios.post(writeUrl, line, {
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'text/plain; charset=utf-8'
      },
      timeout: 5000
    });
    return res.status === 204 || res.status === 200;
  } catch (err) {
    console.warn(`[InfluxEventWriter] Immediate write error:`, err.message);
    return false;
  }
}

/**
 * Ensure the target log bucket exists in InfluxDB, creating it if needed
 */
async function ensureBucketExists(bucketName = INFLUX_BUCKET) {
  try {
    const checkUrl = `${INFLUX_URL}/api/v2/buckets?name=${encodeURIComponent(bucketName)}&org=${encodeURIComponent(INFLUX_ORG)}`;
    const checkRes = await axios.get(checkUrl, {
      headers: { 'Authorization': `Token ${INFLUX_TOKEN}` },
      timeout: 5000
    });

    if (checkRes.data && Array.isArray(checkRes.data.buckets) && checkRes.data.buckets.length > 0) {
      return { exists: true, bucket: checkRes.data.buckets[0] };
    }

    // Lookup orgID
    const orgsRes = await axios.get(`${INFLUX_URL}/api/v2/orgs?org=${encodeURIComponent(INFLUX_ORG)}`, {
      headers: { 'Authorization': `Token ${INFLUX_TOKEN}` },
      timeout: 5000
    });
    const orgObj = (orgsRes.data.orgs || []).find(o => o.name === INFLUX_ORG);
    if (!orgObj) {
      throw new Error(`Org "${INFLUX_ORG}" not found in InfluxDB`);
    }

    // Create bucket
    const createRes = await axios.post(`${INFLUX_URL}/api/v2/buckets`, {
      orgID: orgObj.id,
      name: bucketName,
      retentionRules: [] // 0 = infinite retention
    }, {
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 5000
    });

    return { exists: true, created: true, bucket: createRes.data };
  } catch (err) {
    console.warn(`[InfluxEventWriter] Error ensuring bucket "${bucketName}":`, err.message);
    return { exists: false, error: err.message };
  }
}

/**
 * Query pod events from InfluxDB pod_logs_bhar bucket
 * @param {Object} options
 * { podId, eventType, rootCause, range = '-24h', start, stop, limit = 100 }
 */
async function queryPodEvents({ podId, eventType, rootCause, range = '-24h', start, stop, limit = 100 } = {}) {
  try {
    let fluxRange = `range(start: ${range})`;
    if (start && stop) {
      fluxRange = `range(start: ${start}, stop: ${stop})`;
    } else if (start) {
      fluxRange = `range(start: ${start})`;
    }

    let filters = [`r["_measurement"] == "pod_events"`];
    if (podId !== undefined && podId !== null) {
      filters.push(`r["pod_id"] == "${String(podId)}"`);
    }
    if (eventType) {
      filters.push(`r["event_type"] == "${String(eventType)}"`);
    }
    if (rootCause) {
      filters.push(`r["root_cause"] == "${String(rootCause)}"`);
    }

    const filterClause = filters.map(f => `|> filter(fn: (r) => ${f})`).join('\n  ');

    const fluxQuery = `
from(bucket: "${INFLUX_BUCKET}")
  |> ${fluxRange}
  ${filterClause}
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${Number(limit) || 100})
`;

    const queryUrl = `${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`;
    const response = await axios.post(queryUrl, fluxQuery, {
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv'
      },
      timeout: 10000
    });

    return parseInfluxCsvToEvents(response.data);
  } catch (err) {
    console.warn(`[InfluxEventWriter] Query events failed:`, err.message);
    return [];
  }
}

/**
 * Helper to parse annotated CSV output from InfluxDB into event objects
 */
function parseInfluxCsvToEvents(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  const lines = csvText.split(/\r?\n/);
  const results = [];
  let headers = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(',');
    if (headers.length === 0 || trimmed.includes('_time') || trimmed.includes('pod_id')) {
      if (parts.includes('_time') || parts.includes('pod_id')) {
        headers = parts;
        continue;
      }
    }

    if (headers.length === 0) continue;

    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = parts[i];
    }

    if (row['_time']) {
      results.push({
        id: row['event_id'] || null,
        podId: row['pod_id'] ? Number(row['pod_id']) : null,
        podName: row['pod_name'] || null,
        eventType: row['event_type'] || 'INFO',
        moduleId: row['module_id'] && row['module_id'] !== 'all' ? Number(row['module_id']) : null,
        moduleName: row['module_name'] || null,
        rootCauseCategory: row['root_cause'] || null,
        message: row['message'] || '',
        downtimeSeconds: row['downtime_seconds'] ? Number(row['downtime_seconds']) : 0,
        lastHb: row['last_hb'] ? Number(row['last_hb']) : null,
        diagnosticHint: row['diagnostic_hint'] || null,
        pingMs: row['ping_ms'] ? Number(row['ping_ms']) : null,
        time: row['_time']
      });
    }
  }

  return results;
}

module.exports = {
  INFLUX_BUCKET,
  writePodEvent,
  writePodEventImmediate,
  writePodHeartbeatTick,
  writePodState,
  flushBuffer,
  ensureBucketExists,
  queryPodEvents,
  formatEventToLineProtocol,
  formatHeartbeatTickToLineProtocol,
  formatPodStateToLineProtocol
};
