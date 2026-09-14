const axios = require('axios');
const { pool } = require('./db');
const { queryPodEvents } = require('./influxEventWriter');

// InfluxDB Connection Config
const INFLUX_URL = (process.env.INFLUX_URL || 'http://10.20.10.3:8086').replace(/\/+$/, '');
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'vV_n_nxn30wFNrhTuXtQo2lJTxnVqmAxXC0QHEvh8gMt2lOJJ5yMzQe7jWRdAAhiNzIxYkCaGXH_6c14wNX4Ew==';
const INFLUX_ORG = process.env.INFLUX_ORG || 'pod';

// Dedicated Bucket for this Monitoring System (Strictly pod_logs_bhar)
// Note: pod_monitoring is used only for central Influx data and NOT used on this page.
const INFLUX_LOGS_BUCKET = process.env.INFLUX_LOGS_BUCKET || process.env.INFLUX_EVENTS_BUCKET || 'pod_logs_bhar';

/**
 * Resolve all possible unit tag and pod identification variants
 * E.g. serverId: 8, name: "POD RIG 30", host: "192.168.199.30"
 * -> units: ["8", "pod_8", "POD_8", "pod_30", "POD_30", "30", "POD RIG 30", "POD-SIM"]
 */
async function resolvePodUnitCandidates(podId) {
  const units = new Set();
  const idStr = String(podId);
  units.add(idStr);
  units.add(`pod_${idStr}`);
  units.add(`POD_${idStr}`);

  try {
    const srv = await pool.query('SELECT id, name, host FROM servers WHERE id = $1', [podId]);
    const row = srv?.rows?.[0];
    if (row) {
      if (row.name) {
        units.add(row.name);
        const digits = row.name.replace(/\D/g, '');
        if (digits) {
          units.add(digits);
          units.add(`pod_${digits}`);
          units.add(`POD_${digits}`);
          units.add(`pod_${Number(digits)}`);
        }
      }
      if (row.host) {
        const lastOctet = row.host.split('.').pop();
        if (lastOctet && !isNaN(Number(lastOctet))) {
          units.add(lastOctet);
          units.add(`pod_${lastOctet}`);
          units.add(`POD_${lastOctet}`);
        }
      }
    }
  } catch (_) {}

  return Array.from(units);
}

/**
 * Execute a Flux query against InfluxDB
 */
async function executeFluxQuery(fluxQuery, timeoutMs = 15000) {
  const queryUrl = `${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`;
  const res = await axios.post(queryUrl, fluxQuery, {
    headers: {
      'Authorization': `Token ${INFLUX_TOKEN}`,
      'Content-Type': 'application/vnd.flux',
      'Accept': 'application/csv'
    },
    timeout: timeoutMs
  });
  return res.data;
}

/**
 * Parse Influx CSV text into array of clean object rows
 */
function parseCsvRows(csvText) {
  if (!csvText || typeof csvText !== 'string') return [];
  const lines = csvText.split(/\r?\n/);
  const rows = [];
  let headers = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const cols = trimmed.split(',');
    if (headers.length === 0 || cols.includes('_value') || cols.includes('_time')) {
      if (cols.includes('_value') || cols.includes('_time') || cols.includes('_field')) {
        headers = cols;
        continue;
      }
    }

    if (headers.length === 0) continue;

    const row = {};
    for (let i = 0; i < headers.length; i++) {
      row[headers[i]] = cols[i];
    }
    rows.push(row);
  }
  return rows;
}

/**
 * Get distinct active dates from InfluxDB pod_logs_bhar for a given pod
 */
async function getPodLogDatesFromInflux(podId) {
  const datesSet = new Set();
  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  // 1. Generate recent 14 calendar dates in WITA (Asia/Makassar)
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(d);
    datesSet.add(dateStr);
  }

  // 2. Query historical timestamps for pod_heartbeat_logs in pod_logs_bhar (last 30 days)
  try {
    const historyQuery = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: -30d)
  |> filter(fn: (r) => r["_measurement"] == "pod_heartbeat_logs" and (${podIdFilter}))
  |> keep(columns: ["_time"])
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 50)
`;
    const csv = await executeFluxQuery(historyQuery, 6000);
    const rows = parseCsvRows(csv);
    for (const r of rows) {
      if (r._time) {
        const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date(r._time));
        datesSet.add(d);
      }
    }
  } catch (_) {}

  // 3. Query event timestamps in pod_logs_bhar
  try {
    const eventsQuery = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: -30d)
  |> filter(fn: (r) => r["_measurement"] == "pod_events" and (${podIdFilter}))
  |> keep(columns: ["_time"])
  |> limit(n: 50)
`;
    const csv = await executeFluxQuery(eventsQuery, 5000);
    const rows = parseCsvRows(csv);
    for (const r of rows) {
      if (r._time) {
        const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date(r._time));
        datesSet.add(d);
      }
    }
  } catch (_) {}

  return Array.from(datesSet).sort().reverse();
}

/**
 * Return virtual stream items for a POD on a specific date from InfluxDB pod_logs_bhar
 */
async function getPodStreamsListFromInflux(podId, dateStr = null) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date());
  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  // Time boundaries in WITA (UTC+8)
  const startIso = `${targetDate}T00:00:00+08:00`;
  const stopIso = `${targetDate}T23:59:59+08:00`;

  let eventCount = 0;
  let hbLogsCount = 0;
  let currentLogsCount = 0;

  try {
    const countsQuery = `
eCount = from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => r["_measurement"] == "pod_events" and (${podIdFilter}))
  |> count()
  |> set(key: "stream", value: "events")

hbCount = from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => r["_measurement"] == "pod_heartbeat_logs" and (${podIdFilter}) and r["_field"] == "hb")
  |> count()
  |> set(key: "stream", value: "heartbeats")

cCount = from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => r["_measurement"] == "pod_heartbeat_logs" and (${podIdFilter}) and r["_field"] == "current")
  |> count()
  |> set(key: "stream", value: "current")

union(tables: [eCount, hbCount, cCount])
`;
    const csv = await executeFluxQuery(countsQuery, 8000);
    const rows = parseCsvRows(csv);
    for (const r of rows) {
      const val = Number(r._value) || 0;
      if (r.stream === 'events') eventCount += val;
      if (r.stream === 'heartbeats') hbLogsCount += val;
      if (r.stream === 'current') currentLogsCount += val;
    }
  } catch (err) {
    // If counts query times out, fallback gracefully
  }

  const effectiveHb = hbLogsCount;
  const effectiveCurrent = currentLogsCount > 0 ? currentLogsCount : hbLogsCount;
  const nowIso = new Date().toISOString();

  // Define virtual streams strictly from pod_logs_bhar
  const streams = [
    {
      name: `events_${targetDate}.jsonl`,
      displayName: 'Aliran Peristiwa & Insiden (Events)',
      category: 'events',
      type: 'events',
      recordType: 'events',
      sourceBucket: INFLUX_LOGS_BUCKET,
      measurement: 'pod_events',
      date: targetDate,
      lineCount: eventCount,
      sizeBytes: eventCount * 320,
      sizeFormatted: `${eventCount} Records`,
      modifiedAt: nowIso,
      description: 'Rekaman insiden armada, deteksi status DEAD/WARN, downtime, dan catatan pemulihan (pod_logs_bhar).'
    },
    {
      name: `heartbeat_logs_${targetDate}.jsonl`,
      displayName: 'Log Detak Heartbeat Modul (hb_logs)',
      category: 'heartbeats',
      type: 'heartbeats',
      recordType: 'heartbeats',
      sourceBucket: INFLUX_LOGS_BUCKET,
      measurement: 'pod_heartbeat_logs',
      field: 'hb',
      date: targetDate,
      lineCount: effectiveHb,
      sizeBytes: effectiveHb * 128,
      sizeFormatted: `${effectiveHb} Records`,
      modifiedAt: nowIso,
      description: 'Log detak heartbeat modul operasional yang tersimpan di bucket pod_logs_bhar.'
    },
    {
      name: `current_logs_${targetDate}.jsonl`,
      displayName: 'Log Telemetri Arus Modul (current_logs)',
      category: 'current',
      type: 'current',
      recordType: 'channel_current',
      sourceBucket: INFLUX_LOGS_BUCKET,
      measurement: 'pod_heartbeat_logs',
      field: 'current',
      date: targetDate,
      lineCount: effectiveCurrent,
      sizeBytes: effectiveCurrent * 128,
      sizeFormatted: `${effectiveCurrent} Records`,
      modifiedAt: nowIso,
      description: 'Log arus modul kursi dan konsumsi daya operasional di bucket pod_logs_bhar.'
    },
    {
      name: 'state.json',
      displayName: 'Snapshot Status Terkini POD',
      category: 'state',
      type: 'state',
      recordType: 'state',
      sourceBucket: INFLUX_LOGS_BUCKET,
      measurement: 'pod_state',
      date: targetDate,
      lineCount: 1,
      sizeBytes: 512,
      sizeFormatted: '1 State Record',
      modifiedAt: nowIso,
      description: 'Snapshot kondisi operasional modul dan status kesehatan POD di bucket pod_logs_bhar.'
    }
  ];

  const categoriesCount = {
    all: streams.length,
    events: streams.filter(s => s.category === 'events').length,
    current: streams.filter(s => s.category === 'current').length,
    heartbeats: streams.filter(s => s.category === 'heartbeats').length,
    state: streams.filter(s => s.category === 'state').length
  };

  const dates = await getPodLogDatesFromInflux(podId);

  return {
    success: true,
    podId: Number(podId),
    folderName: `POD_${podId}`,
    date: targetDate,
    source: 'InfluxDB Engine (pod_logs_bhar)',
    filteredFilesCount: streams.length,
    filteredSizeFormatted: `${streams.reduce((acc, s) => acc + s.lineCount, 0)} Total Data Records`,
    dateFolders: dates.map(d => ({
      date: d,
      count: streams.length,
      fileCount: streams.length,
      sizeFormatted: 'Influx Streams'
    })),
    files: streams,
    categories: categoriesCount
  };
}

/**
 * Get raw stream content in JSON or JSONL format from InfluxDB pod_logs_bhar
 */
async function getPodStreamContentFromInflux(podId, streamName, dateStr = null, limit = 500, moduleId = null) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date());
  const startIso = `${targetDate}T00:00:00+08:00`;
  const stopIso = `${targetDate}T23:59:59+08:00`;
  const maxLimit = Math.min(Number(limit) || 500, 2000);

  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  // Support module filtering from explicit param or filename (e.g. module_508_heartbeats.jsonl)
  const parsedMod = streamName.match(/module_(\d+)_/);
  const effectiveModId = (moduleId && moduleId !== 'ALL')
    ? String(moduleId).trim()
    : (parsedMod ? parsedMod[1] : null);
  const modFilter = effectiveModId ? ` and r["module_id"] == "${effectiveModId}"` : '';

  // 1. Events Stream (from pod_logs_bhar)
  if (streamName.startsWith('events') || streamName === 'events') {
    const events = await queryPodEvents({
      podId,
      start: startIso,
      stop: stopIso,
      limit: maxLimit
    });

    const jsonLines = events.map(e => JSON.stringify({
      id: e.id,
      podId: e.podId,
      podName: e.podName,
      eventType: e.eventType,
      message: e.message,
      lastHb: e.lastHb,
      downtimeSeconds: e.downtimeSeconds,
      rootCauseCategory: e.rootCauseCategory,
      diagnosticHint: e.diagnosticHint,
      pingMs: e.pingMs,
      timestamp: new Date(e.time).getTime(),
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(e.time)),
      isoTime: e.time,
      source: 'InfluxDB (pod_logs_bhar)'
    }));

    return {
      success: true,
      podId: Number(podId),
      fileName: streamName,
      date: targetDate,
      source: 'InfluxDB (pod_logs_bhar)',
      totalLines: events.length,
      content: jsonLines.join('\n')
    };
  }

  // 2. Heartbeat Logs Stream (from pod_logs_bhar)
  if (streamName.startsWith('heartbeat_logs') || streamName.startsWith('hb_') || streamName.includes('heartbeat') || streamName === 'pod_heartbeat_logs' || streamName === 'heartbeats') {
    try {
      const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs"${modFilter})
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${maxLimit})
`;
      const csv = await executeFluxQuery(flux, 10000);
      const rows = parseCsvRows(csv);
      const jsonLines = rows.map(r => JSON.stringify({
        ts: new Date(r._time).getTime(),
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(r._time)),
        isoTime: r._time,
        podId: Number(podId),
        modId: Number(r.module_id) || 502,
        hb: Number(r.hb) || 0,
        current: r.current !== undefined ? Number(r.current) : undefined,
        temp: r.temp !== undefined ? Number(r.temp) : undefined,
        humi: r.humi !== undefined ? Number(r.humi) : undefined,
        pob_state: r.pob_state !== undefined ? Number(r.pob_state) : undefined,
        source: 'InfluxDB (pod_logs_bhar)'
      }));

      return {
        success: true,
        podId: Number(podId),
        fileName: streamName,
        date: targetDate,
        source: 'InfluxDB (pod_logs_bhar)',
        totalLines: rows.length,
        content: jsonLines.join('\n')
      };
    } catch (err) {
      return { success: false, error: `Gagal membaca stream heartbeat_logs dari Influx: ${err.message}` };
    }
  }

  // 3. Current Stream (from pod_logs_bhar)
  if (streamName.startsWith('current') || streamName.startsWith('current_logs')) {
    try {
      const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs"${modFilter})
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${maxLimit})
`;
      const csv = await executeFluxQuery(flux, 10000);
      const rows = parseCsvRows(csv);
      const jsonLines = rows.map(r => JSON.stringify({
        ts: new Date(r._time).getTime(),
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(r._time)),
        isoTime: r._time,
        podId: Number(podId),
        modId: Number(r.module_id) || 502,
        current: r.current !== undefined ? Number(r.current) : 0,
        hb: Number(r.hb) || 0,
        temp: r.temp !== undefined ? Number(r.temp) : undefined,
        source: 'InfluxDB (pod_logs_bhar)'
      }));

      return {
        success: true,
        podId: Number(podId),
        fileName: streamName,
        date: targetDate,
        source: 'InfluxDB (pod_logs_bhar)',
        totalLines: rows.length,
        content: jsonLines.join('\n')
      };
    } catch (err) {
      return { success: false, error: `Gagal membaca stream arus dari Influx: ${err.message}` };
    }
  }

  // 4. State Snapshot (from pod_logs_bhar)
  if (streamName === 'state.json' || streamName === 'state') {
    try {
      const stateFlux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: -7d)
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_state")
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: 1)
`;
      const csv = await executeFluxQuery(stateFlux, 6000);
      const rows = parseCsvRows(csv);
      if (rows.length > 0) {
        const row = rows[0];
        const stateObj = {
          podId: Number(podId),
          updatedAt: row._time || new Date().toISOString(),
          source: 'InfluxDB (pod_logs_bhar)',
          status: row.status || 'ALIVE',
          activeModulesCount: Number(row.active_modules_count) || 9,
          deadModulesCount: Number(row.dead_modules_count) || 0,
          activeModules: [501, 502, 503, 504, 505, 506, 507, 508, 509]
        };
        return {
          success: true,
          podId: Number(podId),
          fileName: 'state.json',
          date: targetDate,
          source: 'InfluxDB (pod_logs_bhar)',
          totalLines: 1,
          content: JSON.stringify(stateObj, null, 2)
        };
      }
    } catch (_) {}

    // Fallback if no state row yet in pod_logs_bhar
    const recentEvents = await queryPodEvents({ podId, limit: 1 });
    const latestEvent = recentEvents[0] || null;

    const stateObj = {
      podId: Number(podId),
      updatedAt: new Date().toISOString(),
      source: 'InfluxDB (pod_logs_bhar)',
      status: latestEvent && latestEvent.eventType === 'DEAD' ? 'DEAD' : 'ALIVE',
      lastEvent: latestEvent ? {
        type: latestEvent.eventType,
        message: latestEvent.message,
        time: latestEvent.time
      } : null,
      activeModules: [501, 502, 503, 504, 505, 506, 507, 508, 509]
    };

    return {
      success: true,
      podId: Number(podId),
      fileName: 'state.json',
      date: targetDate,
      source: 'InfluxDB (pod_logs_bhar)',
      totalLines: 1,
      content: JSON.stringify(stateObj, null, 2)
    };
  }

  return { success: false, error: `Aliran data "${streamName}" tidak dikenali.` };
}

/**
 * Get aggregated metrics for chart rendering via InfluxDB aggregateWindow from pod_logs_bhar
 */
async function getPodStreamMetricsFromInflux(podId, streamName, dateStr = null, durationSec = 3600, stepSec = 300, moduleId = null) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date());
  const startIso = `${targetDate}T00:00:00+08:00`;
  const stopIso = `${targetDate}T23:59:59+08:00`;
  const windowEvery = `${Math.max(Number(stepSec) || 300, 60)}s`;

  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  // Support module filtering from explicit param or filename
  const parsedMod = streamName.match(/module_(\d+)_/);
  const effectiveModId = (moduleId && moduleId !== 'ALL')
    ? String(moduleId).trim()
    : (parsedMod ? parsedMod[1] : null);
  const modFilter = effectiveModId ? ` and r["module_id"] == "${effectiveModId}"` : '';

  const isCurrent = streamName.includes('current');
  const targetField = isCurrent ? 'current' : 'hb';
  const targetType = isCurrent ? 'channel_current' : 'heartbeats';
  const unit = isCurrent ? 'mA' : 'Ticks';
  const aggFn = isCurrent ? 'mean' : 'count';

  try {
    const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs" and r["_field"] == "${targetField}"${modFilter})
  |> toFloat()
  |> aggregateWindow(every: ${windowEvery}, fn: ${aggFn}, createEmpty: false)
  |> sort(columns: ["_time"], desc: false)
`;

    const csv = await executeFluxQuery(flux, 15000);
    const rows = parseCsvRows(csv);

    const points = [];
    let latestVal = 0;

    for (const r of rows) {
      if (r._time && r._value !== undefined && r._value !== '') {
        const val = Math.round((Number(r._value) || 0) * 100) / 100;
        const d = new Date(r._time);
        const timeLabel = new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Asia/Makassar',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false
        }).format(d);

        latestVal = val;
        points.push({
          time: timeLabel,
          ts: d.getTime(),
          [targetField]: val,
          avg: val
        });
      }
    }

    return {
      success: true,
      podId: Number(podId),
      date: targetDate,
      detectedType: targetType,
      windowSeconds: durationSec,
      stepSec,
      totalPoints: points.length,
      channels: [targetField],
      unit,
      source: 'InfluxDB (pod_logs_bhar)',
      latestValues: { [targetField]: latestVal },
      points
    };
  } catch (err) {
    console.warn('[PodInfluxRecordService] Failed to query metrics from Influx:', err.message);
    return {
      success: true,
      podId: Number(podId),
      date: targetDate,
      detectedType: targetType,
      channels: [targetField],
      unit,
      source: 'InfluxDB (pod_logs_bhar)',
      latestValues: { [targetField]: 0 },
      points: []
    };
  }
}

/**
 * Stream download of pod telemetry directly from InfluxDB pod_logs_bhar as JSON or JSONL
 */
async function downloadPodTelemetryFromInflux({
  podId,
  serverName = null,
  dateStr = null,
  format = 'json',
  moduleId = null,
  startTime = null,
  endTime = null,
  res
}) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date());
  const startIso = startTime ? `${targetDate}T${startTime}:00+08:00` : `${targetDate}T00:00:00+08:00`;
  const stopIso = endTime ? `${targetDate}T${endTime}:59+08:00` : `${targetDate}T23:59:59+08:00`;
  const safeServerName = (serverName || `pod_${podId}`).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();

  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  const modIdNum = (moduleId !== null && moduleId !== undefined && moduleId !== '' && moduleId !== 'ALL')
    ? Number(moduleId)
    : null;
  const modFilter = modIdNum ? `and r["module_id"] == "${modIdNum}"` : '';
  const fileModSuffix = modIdNum ? `_mod${modIdNum}` : '';

  try {
    const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs" ${modFilter})
  |> pivot(rowKey:["_time"], columnKey: ["_field"], valueColumn: "_value")
  |> sort(columns: ["_time"], desc: false)
  |> limit(n: 5000)
`;

    const csv = await executeFluxQuery(flux, 20000);
    const rows = parseCsvRows(csv);

    const records = rows.map(r => ({
      ts: new Date(r._time).getTime(),
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(r._time)),
      isoTime: r._time,
      podId: Number(podId),
      modId: Number(r.module_id) || modIdNum || 502,
      hb: r.hb !== undefined ? (Number(r.hb) || 0) : undefined,
      current: r.current !== undefined ? (Number(r.current) || 0) : undefined,
      temp: r.temp !== undefined ? (Number(r.temp) || 0) : undefined,
      humi: r.humi !== undefined ? (Number(r.humi) || 0) : undefined,
      pob_state: r.pob_state !== undefined ? (Number(r.pob_state) || 0) : undefined,
      source: 'InfluxDB (pod_logs_bhar)'
    }));

    if (format === 'json') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeServerName}${fileModSuffix}_heartbeats_${targetDate}.json"`);
      return res.send(JSON.stringify(records, null, 2));
    } else {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${safeServerName}${fileModSuffix}_raw_${targetDate}.jsonl"`);
      const body = records.map(r => JSON.stringify(r)).join('\n') + '\n';
      return res.send(body);
    }
  } catch (err) {
    console.error('[PodInfluxRecordService] Telemetry download error:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: `Gagal mengunduh telemetri dari Influx: ${err.message}` });
    }
  }
}

/**
 * Fetch backfill points for live streaming chart directly from InfluxDB pod_logs_bhar
 */
async function getPodLiveBackfillFromInflux({
  podId,
  moduleId = 502,
  dateStr = null,
  windowSeconds = 300,
  type = 'current'
}) {
  const pId = Number(podId);
  const mId = Number(moduleId) || 502;
  const now = new Date();
  const windowSec = Math.max(Number(windowSeconds) || 300, 60);
  const startIso = new Date(now.getTime() - windowSec * 1000).toISOString();
  const stopIso = now.toISOString();

  const unitCandidates = await resolvePodUnitCandidates(pId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  const targetField = type === 'current' ? 'current' : 'hb';

  try {
    const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs" and (r["module_id"] == "${mId}" or r["module_id"] == "502") and (r["_field"] == "${targetField}" or r["_field"] == "hb" or r["_field"] == "current"))
  |> toFloat()
  |> sort(columns: ["_time"], desc: false)
  |> limit(n: 200)
`;
    const csv = await executeFluxQuery(flux, 10000);
    const rows = parseCsvRows(csv);

    const points = rows.map(r => {
      const d = new Date(r._time);
      const val = Math.round((Number(r._value) || 0) * 100) / 100;
      return {
        time: new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Makassar', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d),
        ts: d.getTime(),
        [r._field]: val,
        avg: val
      };
    });

    return {
      success: true,
      podId: pId,
      moduleId: mId,
      windowSeconds: windowSec,
      totalPoints: points.length,
      points,
      source: 'InfluxDB (pod_logs_bhar)'
    };
  } catch (err) {
    console.warn('[PodInfluxRecordService] Backfill error:', err.message);
    return {
      success: true,
      podId: pId,
      moduleId: mId,
      windowSeconds: windowSec,
      totalPoints: 0,
      points: [],
      source: 'InfluxDB (pod_logs_bhar)'
    };
  }
}

/**
 * Query heartbeats for a pod from InfluxDB pod_logs_bhar (used by /api/pod-activity/pods/:id/heartbeats)
 */
async function getPodHeartbeatsFromInflux({
  podId,
  dateStr = null,
  moduleId = null,
  startTime = null,
  endTime = null,
  limit = 500
}) {
  const targetDate = dateStr || new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar' }).format(new Date());
  const startIso = startTime ? `${targetDate}T${startTime}:00+08:00` : `${targetDate}T00:00:00+08:00`;
  const stopIso = endTime ? `${targetDate}T${endTime}:59+08:00` : `${targetDate}T23:59:59+08:00`;
  const maxLimit = Math.min(Number(limit) || 500, 2000);

  const unitCandidates = await resolvePodUnitCandidates(podId);
  const podIdFilter = unitCandidates.map(u => `r["pod_id"] == "${u}" or r["unit"] == "${u}" or r["pod_name"] == "${u}"`).join(' or ');

  const modIdNum = (moduleId !== null && moduleId !== undefined && moduleId !== '' && moduleId !== 'ALL')
    ? Number(moduleId)
    : null;
  const modFilter = modIdNum ? `and r["module_id"] == "${modIdNum}"` : '';

  try {
    const flux = `
from(bucket: "${INFLUX_LOGS_BUCKET}")
  |> range(start: ${startIso}, stop: ${stopIso})
  |> filter(fn: (r) => (${podIdFilter}) and r["_measurement"] == "pod_heartbeat_logs" and r["_field"] == "hb" ${modFilter})
  |> sort(columns: ["_time"], desc: true)
  |> limit(n: ${maxLimit})
`;
    const csv = await executeFluxQuery(flux, 10000);
    const rows = parseCsvRows(csv);

    return rows.map(r => ({
      ts: new Date(r._time).getTime(),
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Makassar', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(r._time)),
      isoTime: r._time,
      podId: Number(podId),
      modId: Number(r.module_id) || modIdNum || 502,
      hb: Number(r._value) || 0,
      source: 'InfluxDB (pod_logs_bhar)'
    }));
  } catch (err) {
    console.warn('[PodInfluxRecordService] getPodHeartbeatsFromInflux error:', err.message);
    return [];
  }
}

/**
 * Get recent incidents across all PODs from pod_logs_bhar
 */
async function getRecentFleetIncidentsFromInflux(limit = 100) {
  try {
    return await queryPodEvents({ limit });
  } catch (err) {
    console.warn('[PodInfluxRecordService] Failed to query fleet incidents:', err.message);
    return [];
  }
}

module.exports = {
  INFLUX_LOGS_BUCKET,
  resolvePodUnitCandidates,
  getPodLogDatesFromInflux,
  getPodStreamsListFromInflux,
  getPodStreamContentFromInflux,
  getPodStreamMetricsFromInflux,
  getRecentFleetIncidentsFromInflux,
  downloadPodTelemetryFromInflux,
  getPodLiveBackfillFromInflux,
  getPodHeartbeatsFromInflux
};
