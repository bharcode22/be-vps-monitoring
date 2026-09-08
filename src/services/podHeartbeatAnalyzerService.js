const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { dbAsync, pool } = require('./db');
const {
  getPodDir,
  formatLocalDate,
  getPodEventsLogPath,
  getPodHeartbeatsLogPath,
  getRecentFleetIncidents
} = require('./podStorageService');
const {
  getHeartbeatThresholdsConfig,
  getModuleNameById,
  getHeartbeatModulesConfig
} = require('./podHeartbeatConfigService');

/**
 * Parse various target time formats into timestamp (ms) and date string (YYYY-MM-DD)
 */
function parseTargetTime(targetTime, explicitDate = null) {
  const now = Date.now();
  if (!targetTime) {
    const dStr = explicitDate || formatLocalDate(now);
    return { targetMs: now, dateStr: dStr };
  }

  // 1. Numeric epoch timestamp (ms or seconds)
  if (typeof targetTime === 'number' || (!isNaN(Number(targetTime)) && String(targetTime).trim().length >= 10)) {
    let num = Number(targetTime);
    if (num < 10000000000) num *= 1000; // Convert seconds to ms
    const dStr = explicitDate || formatLocalDate(num);
    return { targetMs: num, dateStr: dStr };
  }

  const str = String(targetTime).trim();

  // 2. ISO timestamp string (e.g. 2026-09-08T07:21:27.000Z)
  if (str.includes('T')) {
    const parsed = Date.parse(str);
    if (!isNaN(parsed)) {
      return { targetMs: parsed, dateStr: explicitDate || formatLocalDate(parsed) };
    }
  }

  // 3. Date and Time (YYYY-MM-DD HH:mm:ss)
  const dtMatch = str.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (dtMatch) {
    const dStr = dtMatch[1];
    const hour = dtMatch[2].padStart(2, '0');
    const min = dtMatch[3].padStart(2, '0');
    const sec = (dtMatch[4] || '00').padStart(2, '0');
    const d = new Date(`${dStr}T${hour}:${min}:${sec}`);
    if (!isNaN(d.getTime())) {
      return { targetMs: d.getTime(), dateStr: explicitDate || dStr };
    }
  }

  // 4. Time only (HH:mm:ss or HH:mm)
  const tMatch = str.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (tMatch) {
    const dStr = explicitDate || formatLocalDate(now);
    const hour = tMatch[1].padStart(2, '0');
    const min = tMatch[2].padStart(2, '0');
    const sec = (tMatch[3] || '00').padStart(2, '0');
    const d = new Date(`${dStr}T${hour}:${min}:${sec}`);
    if (!isNaN(d.getTime())) {
      return { targetMs: d.getTime(), dateStr: dStr };
    }
  }

  return { targetMs: now, dateStr: explicitDate || formatLocalDate(now) };
}

/**
 * Read raw ticks from JSONL file filtered by module and time window
 */
function readTicksFromFile(filePath, modFilter = null, startMs = null, endMs = null) {
  if (!fs.existsSync(filePath)) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      const items = [];
      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const tick = JSON.parse(trimmed);
          if (modFilter !== null && Number(tick.modId) !== Number(modFilter)) return;
          if (startMs !== null && tick.ts < startMs) return;
          if (endMs !== null && tick.ts > endMs) return;
          items.push(tick);
        } catch (_) { }
      });
      rl.on('close', () => resolve(items));
      rl.on('error', () => resolve(items));
    } catch (_) {
      resolve([]);
    }
  });
}

/**
 * Load ticks for a pod & module in a given time window
 */
async function loadTicksForWindow(podId, moduleId, targetDate, startMs, endMs) {
  const modIdNum = Number(moduleId);
  const podDir = getPodDir(podId);
  const dateDir = path.join(podDir, targetDate);

  const filePromises = [];

  // Check specific module files: hb_[moduleId]_[date].jsonl and current_[moduleId]_[date].jsonl
  if (fs.existsSync(dateDir) && fs.statSync(dateDir).isDirectory()) {
    const hbFile = path.join(dateDir, `hb_${modIdNum}_${targetDate}.jsonl`);
    const curFile = path.join(dateDir, `current_${modIdNum}_${targetDate}.jsonl`);

    if (fs.existsSync(hbFile)) filePromises.push(readTicksFromFile(hbFile, modIdNum, startMs, endMs));
    if (fs.existsSync(curFile)) filePromises.push(readTicksFromFile(curFile, modIdNum, startMs, endMs));
  }

  // Legacy fallback file
  const legacyFile = getPodHeartbeatsLogPath(podId, targetDate, modIdNum);
  if (filePromises.length === 0 && fs.existsSync(legacyFile) && !fs.statSync(legacyFile).isDirectory()) {
    filePromises.push(readTicksFromFile(legacyFile, modIdNum, startMs, endMs));
  }

  let ticks = [];
  if (filePromises.length > 0) {
    const results = await Promise.all(filePromises);
    ticks = results.flat();
  }

  // De-duplicate ticks by ts & hb
  const seen = new Set();
  const deduped = [];
  for (const t of ticks) {
    const key = `${t.ts}_${t.hb}_${t.modId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(t);
    }
  }

  // Sort ascending by timestamp
  deduped.sort((a, b) => a.ts - b.ts);

  // Filter consecutive duplicate entries where timestamp and hb are identical
  const cleaned = [];
  for (let i = 0; i < deduped.length; i++) {
    const curr = deduped[i];
    const prev = cleaned[cleaned.length - 1];
    if (prev && prev.ts === curr.ts && prev.hb === curr.hb) {
      continue;
    }
    cleaned.push(curr);
  }

  return cleaned;
}

/**
 * Load events / incidents for pod & module in the target window
 */
async function loadIncidentsForWindow(podId, moduleId, targetDate, startMs, endMs) {
  const incidents = [];

  // 1. Read from daily events JSONL file
  const eventsFile = getPodEventsLogPath(podId, targetDate);
  if (fs.existsSync(eventsFile)) {
    try {
      const fileStream = fs.createReadStream(eventsFile, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed);
          if (ev.moduleId !== null && ev.moduleId !== undefined && Number(ev.moduleId) !== Number(moduleId)) continue;
          if (startMs !== null && ev.timestamp < startMs) continue;
          if (endMs !== null && ev.timestamp > endMs) continue;
          incidents.push(ev);
        } catch (_) { }
      }
    } catch (_) { }
  }

  // 2. Query Postgres/SQLite pod_heartbeat_alerts table as backup
  try {
    const startDate = new Date(startMs).toISOString();
    const endDate = new Date(endMs).toISOString();
    const dbAlerts = await pool.query(
      `SELECT id, server_id, server_name, module_id, module_name, alert_type, message, last_hb, duration_seconds, created_at
       FROM pod_heartbeat_alerts
       WHERE server_id = $1 AND module_id = $2 AND created_at >= $3 AND created_at <= $4
       ORDER BY created_at ASC`,
      [podId, moduleId, startDate, endDate]
    );

    if (dbAlerts?.rows?.length > 0) {
      for (const row of dbAlerts.rows) {
        const rowTs = new Date(row.created_at).getTime();
        if (!incidents.some(ev => Math.abs(ev.timestamp - rowTs) < 3000 && ev.eventType === row.alert_type)) {
          incidents.push({
            id: `db_${row.id}`,
            podId: row.server_id,
            podName: row.server_name,
            moduleId: row.module_id,
            moduleName: row.module_name,
            eventType: row.alert_type,
            message: row.message,
            lastHb: row.last_hb,
            downtimeSeconds: row.duration_seconds,
            timestamp: rowTs,
            isoTime: row.created_at
          });
        }
      }
    }
  } catch (_) { }

  incidents.sort((a, b) => a.timestamp - b.timestamp);
  return incidents;
}

/**
 * Classify root cause heuristic pattern based on computed ticks and gaps
 */
function classifyRootCauseHeuristic({
  gaps,
  ticksWithDelta,
  targetMs,
  deadThresholdSec,
  frozenThresholdSec,
  moduleName,
  port
}) {
  if (!ticksWithDelta || ticksWithDelta.length === 0) {
    return {
      patternType: 'NO_DATA',
      severity: 'WARNING',
      patternTitle: 'Tidak Ada Data Detak (Data Kosong)',
      summary: `Tidak ditemukan rekaman detak untuk modul ${moduleName} pada jendela waktu ini.`,
      rootCauseDetails: 'File log belum terbuat atau pod tidak menyala / belum terhubung ke broker MQTT pada jam tersebut.',
      recommendedAction: 'Periksa koneksi jaringan pod, atau sesuaikan jam/tanggal pencarian.'
    };
  }

  // Find the most relevant gap near targetMs
  let primaryGap = null;
  if (gaps.length > 0) {
    // Gap closest to targetMs
    primaryGap = [...gaps].sort((a, b) => Math.abs(a.endTs - targetMs) - Math.abs(b.endTs - targetMs))[0];
  }

  // Case 1: Gap exceeding dead threshold detected!
  if (primaryGap && primaryGap.durationSec >= deadThresholdSec) {
    const { durationSec, beforeHb, afterHb, hbDiff, startTs, endTs } = primaryGap;
    const gapDurationStr = `${durationSec.toFixed(1)} detik`;
    const beforeTime = new Date(startTs).toLocaleTimeString('id-ID');
    const afterTime = new Date(endTs).toLocaleTimeString('id-ID');

    // Pola 1A: Counter did NOT reset (incremented smoothly or jumped slightly, <= 3)
    if (beforeHb !== null && afterHb !== null && afterHb >= beforeHb && hbDiff <= 3) {
      return {
        patternType: 'TRANSIENT_IO_LAG',
        severity: 'WARNING',
        patternTitle: 'Jeda Komunikasi Sementara (Serial / OS Lag Spike)',
        summary: `Modul berhenti mengirim paket selama ${gapDurationStr} (melebihi batas DEAD ${deadThresholdSec}s), namun counter langsung menyambung dari #${beforeHb} ke #${afterHb} tanpa reset.`,
        rootCauseDetails: `Modul hardware fisik TIDAK mati ataupun restart. Counter tetap berjalan di memori perangkat. Penyebabnya adalah terhambatnya pengiriman data dari ${port || 'port serial'} ke broker MQTT—misalnya buffer serial tersendat, thread OS di pod sempat sibuk (CPU spike), atau transmisi jaringan mengalami jitter.`,
        recommendedAction: `1. Periksa kestabilan kabel USB (${port || 'serial'}) pada pod agar tidak kendur.
2. Periksa utilitas CPU / thread audio di POD pada jam tersebut.
3. Pertimbangkan untuk menaikkan Dead Threshold sedikit jika latensi serial berkisar di ~${Math.ceil(durationSec)} detik.`,
        gapDetails: primaryGap
      };
    }

    // Pola 1B: Counter Reset to <= 1 or dropped significantly -> Hardware / Driver Restart
    if (beforeHb !== null && afterHb !== null && (afterHb <= 2 || afterHb < beforeHb)) {
      return {
        patternType: 'HARDWARE_REBOOT',
        severity: 'CRITICAL',
        patternTitle: 'Modul Restart / Reset Catu Daya (Counter Reset)',
        summary: `Setelah jeda ${gapDurationStr}, counter detak ter-reset dari #${beforeHb} kembali ke #${afterHb}. Modul perangkat keras atau proses driver mengalami restart.`,
        rootCauseDetails: `Counter detak dimulai kembali dari angka awal, mengindikasikan modul microcontroller (MCU) kehilangan catu daya sesaat (brownout/power dip) atau daemon proses driver modul di pod mengalami crash lalu di-spawn ulang oleh supervisor.`,
        recommendedAction: `1. Periksa kabel daya 5V/12V dan koneksi terminal modul.
2. Cek log sistem OS di POD (/var/log/syslog atau journalctl) untuk mencari indikasi USB disconnect/re-enumerate.
3. Pastikan tidak ada lonjakan beban arus yang memicu proteksi power relay.`,
        gapDetails: primaryGap
      };
    }

    // Pola 1C: Counter jumped significantly (> 3 ticks missed) -> Network/Broker packet drop
    if (beforeHb !== null && afterHb !== null && afterHb > beforeHb && hbDiff > 3) {
      return {
        patternType: 'PACKET_DROP',
        severity: 'WARNING',
        patternTitle: 'Paket Hilang di Jalur Transport (Network / MQTT Drop)',
        summary: `Terjadi jeda ${gapDurationStr}, dan counter melompat dari #${beforeHb} ke #${afterHb} (+${hbDiff} detak hilang di perjalanan).`,
        rootCauseDetails: `Modul hardware tetap berdetak secara normal di pod, namun paket-paket di antara #${beforeHb} dan #${afterHb} tidak pernah sampai ke server backend. Masalah terletak pada konektivitas jaringan (WiFi/LAN jitter) atau broker MQTT yang men-drop paket QoS 0.`,
        recommendedAction: `1. Periksa ping latency dan packet loss antara POD dan broker MQTT.
2. Cek koneksi router / access point yang menghubungkan pod ke server.`,
        gapDetails: primaryGap
      };
    }

    // General gap
    return {
      patternType: 'COMMUNICATION_DROPOUT',
      severity: 'WARNING',
      patternTitle: 'Koneksi Terputus Sementara',
      summary: `Terjadi jeda hening selama ${gapDurationStr} antara ${beforeTime} dan ${afterTime}.`,
      rootCauseDetails: `Tidak ada paket yang diterima selama ${gapDurationStr}. Setelah jeda tersebut, transmisi kembali pulih.`,
      recommendedAction: 'Periksa fisik port USB dan log koneksi serial pod.',
      gapDetails: primaryGap
    };
  }

  // Case 2: Check for Frozen Counter (stuck counter value across packets)
  let maxFrozenSec = 0;
  let frozenHbVal = null;
  let currentFrozenStart = null;

  for (let i = 1; i < ticksWithDelta.length; i++) {
    const curr = ticksWithDelta[i];
    const prev = ticksWithDelta[i - 1];
    if (curr.hb !== null && curr.hb !== undefined && curr.hb === prev.hb) {
      if (!currentFrozenStart) currentFrozenStart = prev.ts;
      const duration = (curr.ts - currentFrozenStart) / 1000;
      if (duration > maxFrozenSec) {
        maxFrozenSec = duration;
        frozenHbVal = curr.hb;
      }
    } else {
      currentFrozenStart = null;
    }
  }

  if (maxFrozenSec >= frozenThresholdSec) {
    return {
      patternType: 'FROZEN_STUCK',
      severity: 'WARNING',
      patternTitle: 'Counter Macet / Nilai Tetap (Frozen State)',
      summary: `Paket data tetap masuk secara reguler, namun nilai counter #${frozenHbVal} tidak bertambah selama ${maxFrozenSec.toFixed(1)} detik (melebihi ambang FROZEN ${frozenThresholdSec}s).`,
      rootCauseDetails: 'Microcontroller atau thread pengirim di modul hardware hang/stuck di suatu loop internal sehingga terus mem-broadcast nilai counter terakhir tanpa meng-inkrementasi nilainya.',
      recommendedAction: `1. Periksa firmware modul ${moduleName}.
2. Periksa apakah thread serial terblokir oleh operasi sinkronus (misal audio buffer blocking).`,
      maxFrozenSec,
      frozenHbVal
    };
  }

  // Case 3: Check for Rapid Late Burst Delivery (many packets arriving within <50ms after a lag)
  let burstCount = 0;
  for (let i = 1; i < ticksWithDelta.length; i++) {
    if (ticksWithDelta[i].deltaSec < 0.08 && ticksWithDelta[i - 1].deltaSec > 3.0) {
      burstCount++;
    }
  }
  if (burstCount >= 2) {
    return {
      patternType: 'BURST_FLUSH',
      severity: 'INFO',
      patternTitle: 'Antrean Paket Tertahan Lalu Terlepas Sekaligus (Buffer Flush)',
      summary: 'Ditemukan lonjakan paket yang tiba serentak dalam selisih milidetik setelah jeda sesaat.',
      rootCauseDetails: 'Antrean broker MQTT atau buffer serial pod sempat tertahan sementara, lalu dilepaskan secara bersamaan (burst delivery) ketika koneksi kembali lancar.',
      recommendedAction: 'Kondisi ini wajar jika terjadi sesekali akibat flush buffer socket jaringan.',
      burstCount
    };
  }

  // Case 4: Healthy / Continuous
  const avgDelta = (ticksWithDelta.reduce((acc, t) => acc + (t.deltaSec || 0), 0) / ticksWithDelta.length).toFixed(2);
  return {
    patternType: 'HEALTHY_NORMAL',
    severity: 'INFO',
    patternTitle: 'Aliran Detak Normal & Teratur',
    summary: `Modul berdetak teratur dengan rata-rata interval ${avgDelta} detik tanpa gap yang melebihi batas toleransi.`,
    rootCauseDetails: 'Semua paket tiba tepat waktu dan counter bertambah secara konsisten.',
    recommendedAction: 'Tidak diperlukan tindakan perbaikan.'
  };
}

/**
 * Main Analysis Function: Computes full incident timeline, delta metrics, and diagnosis
 */
async function analyzeHeartbeatPattern({
  podId,
  moduleId,
  targetTime = null,
  dateStr = null,
  windowMinutes = 5
}) {
  const pId = Number(podId);
  const mId = Number(moduleId);
  const winMin = Math.min(60, Math.max(1, parseInt(windowMinutes, 10) || 5));

  // 1. Resolve target timestamp and date
  const { targetMs, dateStr: resolvedDate } = parseTargetTime(targetTime, dateStr);
  const windowMs = winMin * 60 * 1000;
  const startMs = targetMs - windowMs;
  const endMs = targetMs + windowMs;

  // 2. Resolve Server and Module Names with Smart Identifier Mapping
  let serverName = `POD ${pId}`;
  let effectivePodId = pId;
  try {
    const srv = await dbAsync.get(
      'SELECT id, name, code, host FROM servers WHERE id = ? OR code = ? OR name = ? OR name = ?',
      [pId, String(pId), `POD ${pId}`, `POD_${pId}`]
    );
    if (srv) {
      serverName = srv.name;
      effectivePodId = srv.id;
    }
  } catch (_) { }

  const moduleName = getModuleNameById(mId);
  const thresholds = getHeartbeatThresholdsConfig();
  const deadSec = thresholds.deadSec || 15;
  const frozenSec = thresholds.frozenSec || 10;
  const delaySec = thresholds.delaySec || 2;

  // 3. Load ticks and incidents (try effectivePodId first, fallback to pId)
  let rawTicks = await loadTicksForWindow(effectivePodId, mId, resolvedDate, startMs, endMs);
  if (rawTicks.length === 0 && effectivePodId !== pId) {
    rawTicks = await loadTicksForWindow(pId, mId, resolvedDate, startMs, endMs);
  }
  const incidents = await loadIncidentsForWindow(effectivePodId, mId, resolvedDate, startMs, endMs);

  // 4. Compute intervals, deltas, and gaps
  const ticksWithDelta = [];
  const gaps = [];
  let detectedPort = null;

  for (let i = 0; i < rawTicks.length; i++) {
    const curr = rawTicks[i];
    if (curr.port && !detectedPort) detectedPort = curr.port;

    let deltaSec = null;
    let deltaHb = null;
    let status = 'NORMAL';

    if (i > 0) {
      const prev = rawTicks[i - 1];
      deltaSec = Math.round(((curr.ts - prev.ts) / 1000) * 100) / 100;

      if (curr.hb !== null && curr.hb !== undefined && prev.hb !== null && prev.hb !== undefined) {
        deltaHb = curr.hb - prev.hb;
      }

      if (deltaSec >= deadSec) {
        status = 'GAP_DEAD';
        gaps.push({
          startTs: prev.ts,
          endTs: curr.ts,
          durationSec: deltaSec,
          beforeHb: prev.hb !== undefined ? prev.hb : null,
          afterHb: curr.hb !== undefined ? curr.hb : null,
          hbDiff: deltaHb,
          port: curr.port || prev.port || detectedPort
        });
      } else if (deltaSec >= 3.0) {
        status = 'GAP_LAG';
      } else if (deltaHb === 0 && deltaSec >= frozenSec) {
        status = 'FROZEN';
      }
    }

    ticksWithDelta.push({
      index: i + 1,
      ts: curr.ts,
      date: curr.date || new Date(curr.ts).toLocaleString('id-ID'),
      time: new Date(curr.ts).toLocaleTimeString('id-ID', { hour12: false }),
      hb: curr.hb !== undefined ? curr.hb : null,
      deltaSec,
      deltaHb,
      status,
      port: curr.port || detectedPort || null,
      payload: curr.payload || null
    });
  }

  // 5. Compute summary statistics
  const validDeltas = ticksWithDelta.filter(t => t.deltaSec !== null).map(t => t.deltaSec);
  const maxDeltaSec = validDeltas.length > 0 ? Math.max(...validDeltas) : 0;
  const minDeltaSec = validDeltas.length > 0 ? Math.min(...validDeltas) : 0;
  const avgDeltaSec = validDeltas.length > 0 ? Number((validDeltas.reduce((a, b) => a + b, 0) / validDeltas.length).toFixed(2)) : 0;

  // 6. Run Heuristic Classifier
  const diagnosis = classifyRootCauseHeuristic({
    gaps,
    ticksWithDelta,
    targetMs,
    deadThresholdSec: deadSec,
    frozenThresholdSec: frozenSec,
    moduleName,
    port: detectedPort
  });

  return {
    success: true,
    meta: {
      podId: pId,
      serverName,
      moduleId: mId,
      moduleName,
      port: detectedPort,
      dateStr: resolvedDate,
      targetTimestamp: targetMs,
      targetTimeStr: new Date(targetMs).toLocaleString('id-ID'),
      windowMinutes: winMin,
      windowStart: new Date(startMs).toLocaleString('id-ID'),
      windowEnd: new Date(endMs).toLocaleString('id-ID'),
      thresholds: {
        deadSec,
        frozenSec,
        delaySec
      }
    },
    statistics: {
      totalTicks: ticksWithDelta.length,
      maxDeltaSec,
      minDeltaSec,
      avgDeltaSec,
      totalGapsExceedingDead: gaps.length,
      totalAlertsInWindow: incidents.length
    },
    diagnosis,
    gaps,
    incidents,
    ticks: ticksWithDelta
  };
}

/**
 * Get recent incidents across the fleet for easy 1-click selection
 */
async function getRecentIncidentList(limit = 40) {
  const incidents = [];
  const seenKeys = new Set();

  // 1. From memory ring buffer
  const memEvents = getRecentFleetIncidents(100);
  for (const ev of memEvents) {
    if (ev.eventType === 'DEAD' || ev.eventType === 'FROZEN' || ev.alertType === 'DEAD' || ev.alertType === 'FROZEN') {
      const ts = ev.timestamp || Date.now();
      const pId = ev.podId || ev.serverId;
      const mId = ev.moduleId;
      const key = `${pId}_${mId}_${Math.floor(ts / 10000)}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        incidents.push({
          id: ev.id || `inc_${ts}`,
          podId: Number(pId),
          serverName: ev.podName || ev.serverName || `POD ${pId}`,
          moduleId: Number(mId),
          moduleName: ev.moduleName || getModuleNameById(mId),
          alertType: ev.eventType || ev.alertType,
          message: ev.message,
          lastHb: ev.lastHb,
          downtimeSeconds: ev.downtimeSeconds || ev.durationSeconds || 0,
          timestamp: ts,
          timeFormatted: new Date(ts).toLocaleString('id-ID', {
            day: '2-digit',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }) + ' WIB'
        });
      }
    }
  }

  // 2. From database table pod_heartbeat_alerts as persistent history
  try {
    const dbAlerts = await pool.query(
      `SELECT id, server_id, server_name, module_id, module_name, alert_type, message, last_hb, duration_seconds, created_at
       FROM pod_heartbeat_alerts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );

    if (dbAlerts?.rows?.length > 0) {
      for (const row of dbAlerts.rows) {
        const ts = new Date(row.created_at).getTime();
        const key = `${row.server_id}_${row.module_id}_${Math.floor(ts / 10000)}`;
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          incidents.push({
            id: `db_${row.id}`,
            podId: Number(row.server_id),
            serverName: row.server_name || `POD ${row.server_id}`,
            moduleId: Number(row.module_id),
            moduleName: row.module_name || getModuleNameById(row.module_id),
            alertType: row.alert_type,
            message: row.message,
            lastHb: row.last_hb,
            downtimeSeconds: row.duration_seconds || 0,
            timestamp: ts,
            timeFormatted: new Date(ts).toLocaleString('id-ID', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            }) + ' WIB'
          });
        }
      }
    }
  } catch (_) { }

  incidents.sort((a, b) => b.timestamp - a.timestamp);
  return incidents.slice(0, limit);
}

module.exports = {
  analyzeHeartbeatPattern,
  getRecentIncidentList,
  parseTargetTime
};
