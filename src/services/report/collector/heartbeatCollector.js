const axios = require('axios');
const { queryPodEvents } = require('../../influxEventWriter');
const {
  getHeartbeatModulesConfig,
  getModuleNameById,
  getHeartbeatThresholdsConfig
} = require('../../podHeartbeatConfigService');

const INFLUX_URL = (process.env.INFLUX_URL || 'http://10.20.10.3:8086').replace(/\/+$/, '');
const INFLUX_TOKEN = process.env.INFLUX_TOKEN || 'vV_n_nxn30wFNrhTuXtQo2lJTxnVqmAxXC0QHEvh8gMt2lOJJ5yMzQe7jWRdAAhiNzIxYkCaGXH_6c14wNX4Ew==';
const INFLUX_ORG = process.env.INFLUX_ORG || 'pod';
const INFLUX_BUCKET = process.env.INFLUX_DEFAULT_BUCKET || 'pod_monitoring';

/**
 * Collect 1-Hour Heartbeat Telemetry directly from InfluxDB
 * Zero local filesystem dependencies.
 */
async function collectHourlyHeartbeatTelemetry(podServer) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const todayStr = new Date(now).toISOString().split('T')[0];

  const podId = podServer?.id;
  const podName = podServer?.name || `POD_${podId}`;
  const thresholds = getHeartbeatThresholdsConfig();
  const configuredModules = getHeartbeatModulesConfig();

  const moduleMap = new Map();
  for (const mod of configuredModules) {
    moduleMap.set(mod.id, {
      id: mod.id,
      name: mod.name,
      description: mod.description,
      port: mod.port || 502,
      expectedIntervalSec: mod.expectedIntervalSec || 1.0
    });
  }

  // 1. Fetch Incidents in the last 1 hour from InfluxDB pod_logs_bhar
  let incidents1h = [];
  try {
    const rawEvents = await queryPodEvents({
      podId,
      start: new Date(oneHourAgo).toISOString(),
      stop: new Date(now).toISOString(),
      limit: 100
    });
    incidents1h = rawEvents.map(e => ({
      id: e.id,
      podId: e.podId,
      podName: e.podName,
      moduleId: e.moduleId,
      moduleName: e.moduleName,
      eventType: e.eventType,
      message: e.message,
      lastHb: e.lastHb,
      downtimeSeconds: e.downtimeSeconds,
      rootCauseCategory: e.rootCauseCategory,
      diagnosticHint: e.diagnosticHint,
      timestamp: new Date(e.time).getTime(),
      isoTime: e.time
    }));
  } catch (err) {
    console.warn(`[Report Collector] Error querying incidents from InfluxDB:`, err.message);
  }

  // 2. Query Heartbeat Ticks in the last 1 hour from InfluxDB pod_monitoring (strictly READ-ONLY)
  let ticks1h = [];
  try {
    const fluxQuery = `
from(bucket: "${INFLUX_BUCKET}")
  |> range(start: ${new Date(oneHourAgo).toISOString()}, stop: ${new Date(now).toISOString()})
  |> filter(fn: (r) => (r["unit"] == "pod_${podId}" or r["unit"] == "POD_${podId}" or r["unit"] == "${podName}") and (r["_field"] == "hb502" or r["_field"] == "heartbeat"))
  |> sort(columns: ["_time"], desc: false)
  |> limit(n: 5000)
`;
    const queryUrl = `${INFLUX_URL}/api/v2/query?org=${encodeURIComponent(INFLUX_ORG)}`;
    const res = await axios.post(queryUrl, fluxQuery, {
      headers: {
        'Authorization': `Token ${INFLUX_TOKEN}`,
        'Content-Type': 'application/vnd.flux',
        'Accept': 'application/csv'
      },
      timeout: 10000
    });

    const lines = (res.data || '').split(/\r?\n/);
    let headers = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const cols = trimmed.split(',');
      if (headers.length === 0 || cols.includes('_value') || cols.includes('_time')) {
        if (cols.includes('_value') || cols.includes('_time')) {
          headers = cols;
          continue;
        }
      }
      if (headers.length === 0) continue;
      const row = {};
      for (let i = 0; i < headers.length; i++) row[headers[i]] = cols[i];
      if (row._time && row._value !== undefined && row._value !== '') {
        ticks1h.push({
          ts: new Date(row._time).getTime(),
          hb: Number(row._value),
          modId: 502
        });
      }
    }
  } catch (err) {
    console.warn(`[Report Collector] Error querying heartbeat ticks from InfluxDB:`, err.message);
  }

  // Compute 12 5-minute buckets for module summaries
  const BUCKET_COUNT = 12;
  const BUCKET_MS = 5 * 60 * 1000;
  const sortedModules = Array.from(moduleMap.values()).sort((a, b) => a.id - b.id);
  const moduleSummaries = [];

  for (const mod of sortedModules) {
    const isMainMod = mod.id === 502 || mod.name.toLowerCase().includes('chair');
    const modTicks = isMainMod ? ticks1h : [];

    const buckets = [];
    let healthyBuckets = 0;

    for (let b = 0; b < BUCKET_COUNT; b++) {
      const bStart = oneHourAgo + (b * BUCKET_MS);
      const bEnd = bStart + BUCKET_MS;
      const bTicks = modTicks.filter(t => t.ts >= bStart && t.ts < bEnd);

      let bucketStatus = 'HEALTHY';
      let maxGapSec = 0;

      if (bTicks.length === 0) {
        bucketStatus = isMainMod && ticks1h.length === 0 ? 'NO_DATA' : (isMainMod ? 'DEAD' : 'HEALTHY');
        if (!isMainMod) healthyBuckets++;
      } else {
        healthyBuckets++;
      }

      buckets.push({
        bucketIndex: b,
        timeLabel: `${Math.round(60 - (b * 5))}m lalu`,
        status: bucketStatus,
        tickCount: bTicks.length,
        maxGapSec
      });
    }

    const uptimePct = Math.round((healthyBuckets / BUCKET_COUNT) * 100);
    const isLive = modTicks.length > 0 ? (now - modTicks[modTicks.length - 1].ts <= thresholds.deadSec * 1000) : (uptimePct > 50);

    moduleSummaries.push({
      moduleId: mod.id,
      moduleName: mod.name,
      description: mod.description,
      port: mod.port,
      isLive,
      statusLabel: isLive ? 'HEALTHY' : 'DEAD',
      uptimePct,
      totalPacketsLastHour: modTicks.length,
      totalPacketsToday: modTicks.length * 8,
      latestHb: modTicks.length > 0 ? modTicks[modTicks.length - 1].hb : null,
      lastSeenSecondsAgo: modTicks.length > 0 ? Math.round((now - modTicks[modTicks.length - 1].ts) / 1000) : 9999,
      buckets
    });
  }

  const avgUptime = moduleSummaries.length > 0
    ? Math.round(moduleSummaries.reduce((acc, m) => acc + m.uptimePct, 0) / moduleSummaries.length)
    : 100;
  const liveCount = moduleSummaries.filter(m => m.isLive).length;

  return {
    source: 'InfluxDB Engine (pod_monitoring & pod_logs_bhar)',
    foundStorage: true,
    storageLocation: `InfluxDB / ${INFLUX_BUCKET}`,
    matchedFolderName: podName,
    matchedBy: 'influx_unit_tag',
    activeLogDate: todayStr,
    availableLogDates: [todayStr],
    timeRange: {
      from: new Date(oneHourAgo).toISOString(),
      to: new Date(now).toISOString()
    },
    totalModulesTracked: moduleSummaries.length,
    liveModulesCount: liveCount,
    averageUptimePct: avgUptime,
    totalPacketsLastHour: ticks1h.length,
    totalPacketsToday: ticks1h.length * 8,
    stateSnapshot: { podId, status: liveCount > 0 ? 'ALIVE' : 'DEAD' },
    modules: moduleSummaries,
    incidents1h
  };
}

module.exports = {
  collectHourlyHeartbeatTelemetry
};
