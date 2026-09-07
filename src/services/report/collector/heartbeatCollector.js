const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { resolvePodStorageDir } = require('./podResolver');
const {
  getHeartbeatModulesConfig,
  getModuleNameById,
  getHeartbeatThresholdsConfig
} = require('../../podHeartbeatConfigService');

/**
 * Collect 1-Hour Heartbeat Telemetry directly from backend/src/data/pod_storage/pods
 */
async function collectHourlyHeartbeatTelemetry(podServer) {
  const now = Date.now();
  const oneHourAgo = now - 60 * 60 * 1000;
  const todayStr = new Date(now).toISOString().split('T')[0];

  const dirMatch = resolvePodStorageDir(podServer);
  if (!dirMatch.found) {
    console.warn(`[Report Collector] ${dirMatch.error}`);
    return {
      source: 'pod_storage/pods',
      foundStorage: false,
      storageLocation: null,
      matchedFolderName: null,
      matchedBy: null,
      activeLogDate: todayStr,
      timeRange: {
        from: new Date(oneHourAgo).toISOString(),
        to: new Date(now).toISOString()
      },
      totalModulesTracked: 0,
      liveModulesCount: 0,
      averageUptimePct: 0,
      totalPacketsLastHour: 0,
      totalPacketsToday: 0,
      stateSnapshot: null,
      modules: [],
      incidents1h: [],
      error: dirMatch.error
    };
  }

  const { podDir, folderName, matchedBy, stateSnapshot } = dirMatch;

  // Determine active date directory (prefer today, fallback to latest available date)
  let activeLogDate = todayStr;
  let dateDir = path.join(podDir, todayStr);
  let availableDates = [];

  try {
    const subEntries = fs.readdirSync(podDir);
    availableDates = subEntries
      .filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e) && fs.statSync(path.join(podDir, e)).isDirectory())
      .sort()
      .reverse();

    if (!fs.existsSync(dateDir) || fs.readdirSync(dateDir).length === 0) {
      if (availableDates.length > 0) {
        activeLogDate = availableDates[0];
        dateDir = path.join(podDir, activeLogDate);
      }
    }
  } catch (err) {
    console.warn(`[Report Collector] Gagal memeriksa subfolder tanggal untuk ${folderName}:`, err.message);
  }

  // Load configured modules from heartbeat_modules_config.json
  const standardModules = getHeartbeatModulesConfig();
  const moduleMap = new Map();
  standardModules.forEach(m => {
    moduleMap.set(Number(m.id), {
      id: Number(m.id),
      name: m.name,
      defaultPort: m.defaultPort || null,
      topic: m.topic || null
    });
  });

  // Discover any additional module files present on disk: hb_[id]_[date].jsonl
  if (fs.existsSync(dateDir)) {
    try {
      const files = fs.readdirSync(dateDir);
      files.forEach(f => {
        const match = f.match(/^hb_(\d+)_/);
        if (match) {
          const mid = Number(match[1]);
          if (!moduleMap.has(mid)) {
            moduleMap.set(mid, {
              id: mid,
              name: getModuleNameById(mid),
              defaultPort: null,
              topic: null
            });
          }
        }
      });
    } catch (_) { }
  }

  const thresholds = getHeartbeatThresholdsConfig();
  const BUCKET_COUNT = 12;
  const BUCKET_MS = 5 * 60 * 1000; // 5 minutes per bucket

  const sortedModules = Array.from(moduleMap.values()).sort((a, b) => a.id - b.id);
  const moduleSummaries = [];
  let fleetTotalPackets1h = 0;
  let fleetTotalPacketsToday = 0;

  for (const mod of sortedModules) {
    const modId = mod.id;
    const modFile = path.join(dateDir, `hb_${modId}_${activeLogDate}.jsonl`);
    const hourlyTicks = [];
    let latestTick = null;
    let latestHbTick = null;
    let totalTicksToday = 0;

    if (fs.existsSync(modFile)) {
      try {
        const stream = fs.createReadStream(modFile, { encoding: 'utf8' });
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

        for await (const line of rl) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const tick = JSON.parse(trimmed);
            totalTicksToday++;
            latestTick = tick;
            if (tick.hb !== undefined && tick.hb !== null && !isNaN(Number(tick.hb))) {
              latestHbTick = tick;
            }
            if (tick.ts >= oneHourAgo && tick.ts <= now) {
              hourlyTicks.push(tick);
            }
          } catch (_) { }
        }
      } catch (fileErr) {
        console.warn(`[Report Collector] Gagal membaca berkas ${modFile}:`, fileErr.message);
      }
    }

    fleetTotalPackets1h += hourlyTicks.length;
    fleetTotalPacketsToday += totalTicksToday;
    hourlyTicks.sort((a, b) => a.ts - b.ts);

    // Compute 12 buckets
    const buckets = [];
    let healthyBuckets = 0;

    for (let b = 0; b < BUCKET_COUNT; b++) {
      const bStart = oneHourAgo + (b * BUCKET_MS);
      const bEnd = bStart + BUCKET_MS;
      const bTicks = hourlyTicks.filter(t => t.ts >= bStart && t.ts < bEnd);

      let bucketStatus = 'HEALTHY';
      let maxGapSec = 0;

      if (bTicks.length === 0) {
        bucketStatus = 'NO_DATA';
      } else {
        let hasDeadGap = false;
        let hasDelayGap = false;

        for (let i = 1; i < bTicks.length; i++) {
          const gapSec = (bTicks[i].ts - bTicks[i - 1].ts) / 1000;
          if (gapSec > maxGapSec) maxGapSec = gapSec;

          if (gapSec >= thresholds.deadSec) {
            hasDeadGap = true;
            break;
          } else if (gapSec >= thresholds.delaySec) {
            hasDelayGap = true;
          }
        }

        if (hasDeadGap) {
          bucketStatus = 'DEAD';
        } else if (hasDelayGap) {
          bucketStatus = 'DELAY';
        } else {
          healthyBuckets++;
        }
      }

      buckets.push({
        bucketIndex: b,
        timeLabel: `${Math.round(60 - (b * 5))}m lalu`,
        status: bucketStatus,
        tickCount: bTicks.length,
        maxGapSec: parseFloat(maxGapSec.toFixed(2))
      });
    }

    const isLive = latestTick ? (now - latestTick.ts <= thresholds.deadSec * 1000) : false;
    const uptimePct = Math.round((healthyBuckets / BUCKET_COUNT) * 100);

    let statusLabel = 'HEALTHY';
    if (isLive) {
      statusLabel = uptimePct >= 80 ? 'LIVE' : 'DEGRADED';
    } else {
      if (hourlyTicks.length > 0) {
        statusLabel = 'OFFLINE';
      } else if (totalTicksToday > 0) {
        statusLabel = 'INACTIVE_1H';
      } else {
        statusLabel = 'NO_DATA';
      }
    }

    moduleSummaries.push({
      moduleId: modId,
      moduleName: mod.name,
      port: mod.defaultPort || (latestTick ? latestTick.port : null),
      topic: mod.topic,
      totalPackets1h: hourlyTicks.length,
      totalPacketsToday: totalTicksToday,
      latestHb: latestHbTick ? Number(latestHbTick.hb) : (latestTick && latestTick.hb !== undefined && latestTick.hb !== null ? Number(latestTick.hb) : null),
      latestSeenAgoSec: latestTick ? Math.round((now - latestTick.ts) / 1000) : null,
      latestSeenIso: latestTick ? latestTick.isoTime : null,
      isLive,
      status: statusLabel,
      uptimePct,
      buckets
    });
  }

  // Collect recent events/incidents from events_[date].jsonl in 1-hour window
  const incidents1h = [];
  const eventsFile = path.join(dateDir, `events_${activeLogDate}.jsonl`);
  if (fs.existsSync(eventsFile)) {
    try {
      const stream = fs.createReadStream(eventsFile, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.timestamp >= oneHourAgo && ev.timestamp <= now) {
            incidents1h.push(ev);
          }
        } catch (_) { }
      }
    } catch (_) { }
  }
  incidents1h.reverse(); // Newest first

  const avgUptime = moduleSummaries.length > 0
    ? Math.round(moduleSummaries.reduce((acc, m) => acc + m.uptimePct, 0) / moduleSummaries.length)
    : 0;

  const liveModulesCount = moduleSummaries.filter(m => m.isLive).length;

  return {
    source: 'pod_storage/pods',
    foundStorage: true,
    storageLocation: `pods/${folderName}/${activeLogDate}`,
    matchedFolderName: folderName,
    matchedBy,
    activeLogDate,
    availableLogDates: availableDates,
    timeRange: {
      from: new Date(oneHourAgo).toISOString(),
      to: new Date(now).toISOString()
    },
    totalModulesTracked: moduleSummaries.length,
    liveModulesCount,
    averageUptimePct: avgUptime,
    totalPacketsLastHour: fleetTotalPackets1h,
    totalPacketsToday: fleetTotalPacketsToday,
    stateSnapshot,
    modules: moduleSummaries,
    incidents1h
  };
}

module.exports = {
  collectHourlyHeartbeatTelemetry
};
