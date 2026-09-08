const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { dbAsync, pool } = require('./db');
const {
  getPodDir,
  formatLocalDate,
  APP_TIMEZONE,
  getPodEventsLogPath,
  getPodHeartbeatsLogPath,
  getRecentFleetIncidents,
  registerPodName
} = require('./podStorageService');
const {
  getHeartbeatThresholdsConfig,
  getModuleNameById,
  getHeartbeatModulesConfig
} = require('./podHeartbeatConfigService');

const WITA_TIMEZONE = 'Asia/Makassar'; // WITA (UTC+8) standard for POD fleet

/**
 * Calculate ISO timezone offset string (e.g. "+08:00" for Asia/Makassar)
 * This guarantees consistent epoch timestamp calculation regardless of whether the backend
 * runs in host OS (Mac/Windows) or inside Docker container (which defaults to UTC).
 */
function getTimezoneOffsetString(tz = WITA_TIMEZONE) {
  try {
    const d = new Date();
    const utcDate = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(d.toLocaleString('en-US', { timeZone: tz }));
    const diffMinutes = Math.round((tzDate.getTime() - utcDate.getTime()) / (1000 * 60));
    const sign = diffMinutes >= 0 ? '+' : '-';
    const absMin = Math.abs(diffMinutes);
    const hours = String(Math.floor(absMin / 60)).padStart(2, '0');
    const mins = String(absMin % 60).padStart(2, '0');
    return `${sign}${hours}:${mins}`;
  } catch (_) {
    return '+08:00';
  }
}

/**
 * Format timestamp into standard "YYYY-MM-DD HH:mm:ss" in WITA (Asia/Makassar)
 */
function formatFullDateTime(ts, timeZone = WITA_TIMEZONE) {
  try {
    const d = new Date(ts);
    const datePart = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    const timePart = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(d);
    return `${datePart} ${timePart}`;
  } catch (_) {
    return new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
  }
}

/**
 * Format timestamp into "HH:mm:ss" in WITA (Asia/Makassar)
 */
function formatTimeOnly(ts, timeZone = WITA_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ts));
  } catch (_) {
    return new Date(ts).toLocaleTimeString('id-ID', { hour12: false });
  }
}

/**
 * Format timestamp into localized "DD MMM YYYY, HH:mm:ss WITA" in WITA (Asia/Makassar)
 */
function formatDateTimeWITA(ts) {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: WITA_TIMEZONE,
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(ts)) + ' WITA';
  } catch (_) {
    return new Date(ts).toLocaleString('id-ID') + ' WITA';
  }
}

/**
 * Parse various target time formats into timestamp (ms) and date string (YYYY-MM-DD)
 * Supports explicit epoch ms, ISO string, and local time strings with Docker-safe timezone resolution in WITA.
 */
function parseTargetTime(targetTime, explicitDate = null) {
  const now = Date.now();
  const effectiveTz = WITA_TIMEZONE;

  if (!targetTime) {
    const dStr = explicitDate || formatLocalDate(now, effectiveTz);
    return { targetMs: now, dateStr: dStr };
  }

  // 1. Numeric epoch timestamp (ms or seconds)
  if (typeof targetTime === 'number' || (!isNaN(Number(targetTime)) && String(targetTime).trim().length >= 10)) {
    let num = Number(targetTime);
    if (num < 10000000000) num *= 1000; // Convert seconds to ms
    const dStr = explicitDate || formatLocalDate(num, effectiveTz);
    return { targetMs: num, dateStr: dStr };
  }

  const str = String(targetTime).trim();

  // 2. ISO timestamp string with timezone indicator (e.g. 2026-09-08T07:21:27.000Z or +08:00)
  if (str.includes('T') && (str.includes('Z') || str.includes('+') || str.lastIndexOf('-') > 7)) {
    const parsed = Date.parse(str);
    if (!isNaN(parsed)) {
      return { targetMs: parsed, dateStr: explicitDate || formatLocalDate(parsed, effectiveTz) };
    }
  }

  const tzOffset = getTimezoneOffsetString(effectiveTz);

  // 3. Date and Time (YYYY-MM-DD HH:mm:ss)
  const dtMatch = str.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (dtMatch) {
    const dStr = dtMatch[1];
    const hour = dtMatch[2].padStart(2, '0');
    const min = dtMatch[3].padStart(2, '0');
    const sec = (dtMatch[4] || '00').padStart(2, '0');
    // Attach configured timezone offset so Docker UTC container parses to the exact Indonesian local time
    const d = new Date(`${dStr}T${hour}:${min}:${sec}${tzOffset}`);
    if (!isNaN(d.getTime())) {
      return { targetMs: d.getTime(), dateStr: explicitDate || dStr };
    }
  }

  // 4. Time only (HH:mm:ss or HH:mm)
  const tMatch = str.match(/^(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/);
  if (tMatch) {
    const dStr = explicitDate || formatLocalDate(now, effectiveTz);
    const hour = tMatch[1].padStart(2, '0');
    const min = tMatch[2].padStart(2, '0');
    const sec = (tMatch[3] || '00').padStart(2, '0');
    // Attach configured timezone offset so Docker UTC container parses to the exact Indonesian local time
    const d = new Date(`${dStr}T${hour}:${min}:${sec}${tzOffset}`);
    if (!isNaN(d.getTime())) {
      return { targetMs: d.getTime(), dateStr: dStr };
    }
  }

  return { targetMs: now, dateStr: explicitDate || formatLocalDate(now, effectiveTz) };
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
async function loadTicksForWindow(podId, moduleId, targetDate, startMs, endMs, serverName = null) {
  const modIdNum = Number(moduleId);
  const podDir = getPodDir(podId, serverName);
  const dateDir = path.join(podDir, targetDate);

  const filePromises = [];

  // Check specific module heartbeat file: hb_[moduleId]_[date].jsonl
  // NOTE: We do NOT load current_[moduleId]_[date].jsonl here. Current files contain electrical
  // sensor readings (PEMF_CUR, EE_12V, etc.) without an 'hb' field, which breaks deltaHb computation.
  if (fs.existsSync(dateDir) && fs.statSync(dateDir).isDirectory()) {
    const hbFile = path.join(dateDir, `hb_${modIdNum}_${targetDate}.jsonl`);
    if (fs.existsSync(hbFile)) {
      filePromises.push(readTicksFromFile(hbFile, modIdNum, startMs, endMs));
    }
  }

  // Legacy fallback file
  const legacyFile = getPodHeartbeatsLogPath(podId, targetDate, modIdNum, serverName);
  if (filePromises.length === 0 && fs.existsSync(legacyFile) && !fs.statSync(legacyFile).isDirectory()) {
    filePromises.push(readTicksFromFile(legacyFile, modIdNum, startMs, endMs));
  }

  let ticks = [];
  if (filePromises.length > 0) {
    const results = await Promise.all(filePromises);
    ticks = results.flat();
  }

  // Prioritize ticks that actually have the 'hb' counter if available
  const ticksWithHb = ticks.filter(t => t.hb !== undefined && t.hb !== null);
  const candidateTicks = ticksWithHb.length > 0 ? ticksWithHb : ticks;

  // De-duplicate ticks by ts & hb & modId
  const seen = new Set();
  const deduped = [];
  for (const t of candidateTicks) {
    const key = `${t.ts}_${t.hb}_${t.modId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(t);
    }
  }

  // Sort ascending by timestamp
  deduped.sort((a, b) => a.ts - b.ts);

  // Filter consecutive duplicate entries where timestamp and hb are identical or duplicate packet burst within 300ms
  const cleaned = [];
  for (let i = 0; i < deduped.length; i++) {
    const curr = deduped[i];
    const prev = cleaned[cleaned.length - 1];
    if (
      prev &&
      prev.hb !== null &&
      prev.hb !== undefined &&
      curr.hb !== null &&
      curr.hb !== undefined &&
      prev.hb === curr.hb &&
      Math.abs(curr.ts - prev.ts) < 300
    ) {
      continue;
    }
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

  // Find the most relevant gap or jump/drop incident near targetMs
  let primaryGap = null;
  const significantGaps = (gaps || []).filter(g =>
    g.durationSec >= deadThresholdSec ||
    g.postDeadType === 'LOMPAT' ||
    g.postDeadType === 'LONCAT' ||
    g.postDeadType === 'RESET' ||
    (g.hbDiff !== null && g.hbDiff > 5)
  );
  if (significantGaps.length > 0) {
    primaryGap = [...significantGaps].sort((a, b) => Math.abs(a.endTs - targetMs) - Math.abs(b.endTs - targetMs))[0];
  } else if (gaps && gaps.length > 0) {
    primaryGap = [...gaps].sort((a, b) => Math.abs(a.endTs - targetMs) - Math.abs(b.endTs - targetMs))[0];
  }

  // Case 1: Significant gap, counter jump (lompat / packet drop), or reset detected!
  if (primaryGap && (primaryGap.durationSec >= deadThresholdSec || primaryGap.postDeadType === 'LOMPAT' || primaryGap.postDeadType === 'LONCAT' || primaryGap.postDeadType === 'RESET' || (primaryGap.hbDiff !== null && primaryGap.hbDiff > 5))) {
    const { durationSec, beforeHb, afterHb, hbDiff, startTs, endTs } = primaryGap;
    const gapDurationStr = `${durationSec.toFixed(1)} detik`;
    const beforeTime = formatTimeOnly(startTs) + ' WITA';
    const afterTime = formatTimeOnly(endTs) + ' WITA';

    // Check if counter reset to 0/1 or dropped backward -> RESET
    const isReset = (afterHb !== null && afterHb !== undefined && afterHb <= 2) ||
      (beforeHb !== null && afterHb !== null && afterHb < beforeHb);

    // Pola 1A: Counter Reset -> RESET
    if (isReset) {
      return {
        patternType: 'HARDWARE_REBOOT',
        postDeadType: 'RESET',
        postDeadLabel: 'RESET (MULAI DARI 0)',
        severity: 'CRITICAL',
        patternTitle: 'RESET (Modul Restart / Catu Daya Drop)',
        summary: `Setelah jeda ${gapDurationStr}, counter detak mengalami RESET dari #${beforeHb ?? '—'} kembali ke #${afterHb ?? '0'}. Modul perangkat keras atau proses driver mengalami restart dari awal (0).`,
        rootCauseDetails: `Counter detak dimulai kembali dari angka awal (0/1), mengindikasikan modul microcontroller (MCU) kehilangan catu daya sesaat (brownout/power dip) atau daemon proses driver modul di pod mengalami crash lalu di-spawn ulang oleh supervisor.`,
        recommendedAction: `1. Periksa kabel daya 5V/12V dan koneksi terminal modul.
2. Cek log sistem OS di POD (/var/log/syslog atau journalctl) untuk mencari indikasi USB disconnect/re-enumerate.
3. Pastikan tidak ada lonjakan beban arus yang memicu proteksi power relay.`,
        gapDetails: {
          ...primaryGap,
          postDeadType: 'RESET',
          postDeadLabel: 'RESET (MULAI DARI 0)'
        }
      };
    }

    // Pola 1B: Counter jumped significantly (> 5 ticks missed) -> LOMPAT / PACKET DROP
    // Contoh kasus: dari hb 46922 ke 46968 (+46 detak terlewat di jalur transport)
    if (beforeHb !== null && afterHb !== null && afterHb > beforeHb && hbDiff > 5) {
      return {
        patternType: 'PACKET_DROP',
        postDeadType: 'LOMPAT',
        postDeadLabel: `LOMPAT (+${hbDiff} Detak Terlewat)`,
        severity: 'WARNING',
        patternTitle: 'LOMPAT (Paket Hilang di Jalur Transport / Network Drop)',
        summary: `Terjadi jeda ${gapDurationStr}, dan counter melompat dari #${beforeHb} ke #${afterHb} (+${hbDiff} detak hilang di perjalanan).`,
        rootCauseDetails: `Modul microcontroller fisik tetap berdetak secara normal di pod, namun ${hbDiff} paket detak (dari #${beforeHb} ke #${afterHb}) tidak pernah sampai ke server backend. Masalah terletak pada konektivitas transport jaringan (WiFi/LAN jitter, antrean QoS 0 broker MQTT drop, atau buffer serial terlewat).`,
        recommendedAction: `1. Periksa ping latency dan packet loss antara POD dan broker MQTT.
2. Cek koneksi router / access point yang menghubungkan pod ke server.
3. Pastikan tidak ada gangguan fisik kabel serial USB pod.`,
        gapDetails: {
          ...primaryGap,
          postDeadType: 'LOMPAT',
          postDeadLabel: `LOMPAT (+${hbDiff} Detak Terlewat)`
        }
      };
    }

    // Pola 1C: Counter did NOT reset (incremented smoothly or <= 5) -> BERLANJUT
    if (beforeHb !== null && afterHb !== null && afterHb >= beforeHb && (hbDiff <= 5 || hbDiff === null)) {
      return {
        patternType: 'TRANSIENT_IO_LAG',
        postDeadType: 'BERLANJUT',
        postDeadLabel: 'BERLANJUT (KONTINU)',
        severity: 'WARNING',
        patternTitle: 'BERLANJUT (Jeda Komunikasi Sementara / OS Lag Spike)',
        summary: `Modul sempat berhenti mengirim paket selama ${gapDurationStr} (melebihi batas DEAD ${deadThresholdSec}s), namun counter detak langsung BERLANJUT dari #${beforeHb} ke #${afterHb} tanpa reset. Hardware fisik TIDAK mati.`,
        rootCauseDetails: `Modul microcontroller (MCU) fisik TIDAK mati ataupun restart. Counter tetap berjalan di memori perangkat. Penyebabnya adalah terhambatnya transmisi data dari ${port || 'port serial'} ke broker MQTT—misalnya buffer serial tersendat, thread OS di pod sempat sibuk (CPU spike), atau transmisi jaringan mengalami jitter.`,
        recommendedAction: `1. Periksa kestabilan kabel USB (${port || 'serial'}) pada pod agar tidak kendur.
2. Periksa utilitas CPU / thread OS di POD pada jam tersebut.
3. Pertimbangkan untuk menaikkan Dead Threshold sedikit jika latensi serial berkisar di ~${Math.ceil(durationSec)} detik.`,
        gapDetails: {
          ...primaryGap,
          postDeadType: 'BERLANJUT',
          postDeadLabel: 'BERLANJUT (KONTINU)'
        }
      };
    }

    // General gap (default to BERLANJUT if counter didn't reset)
    return {
      patternType: 'COMMUNICATION_DROPOUT',
      postDeadType: 'BERLANJUT',
      postDeadLabel: 'BERLANJUT',
      severity: 'WARNING',
      patternTitle: 'Koneksi Terputus Sementara (BERLANJUT)',
      summary: `Terjadi jeda hening selama ${gapDurationStr} antara ${beforeTime} dan ${afterTime}, counter kemudian berlanjut.`,
      rootCauseDetails: `Tidak ada paket yang diterima selama ${gapDurationStr}. Setelah jeda tersebut, transmisi kembali pulih.`,
      recommendedAction: 'Periksa fisik port USB dan log koneksi serial pod.',
      gapDetails: {
        ...primaryGap,
        postDeadType: 'BERLANJUT',
        postDeadLabel: 'BERLANJUT'
      }
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
    // Check by server code or name first (e.g. code = '31' -> POD 31) before raw id to avoid collision
    let srv = await dbAsync.get(
      'SELECT id, name, code, host FROM servers WHERE code = ? OR name = ? OR name = ?',
      [String(pId), `POD ${pId}`, `POD_${pId}`]
    );
    if (!srv) {
      srv = await dbAsync.get(
        'SELECT id, name, code, host FROM servers WHERE id = ?',
        [pId]
      );
    }
    if (srv) {
      serverName = srv.name;
      effectivePodId = srv.id;
    }
  } catch (_) { }

  if (serverName) {
    registerPodName(effectivePodId, serverName);
    registerPodName(pId, serverName);
  }

  const moduleName = getModuleNameById(mId);
  const thresholds = getHeartbeatThresholdsConfig();
  const deadSec = thresholds.deadSec || 15;
  const frozenSec = thresholds.frozenSec || 10;
  const delaySec = thresholds.delaySec || 2;

  // 3. Load ticks and incidents (try effectivePodId first, fallback to pId)
  let rawTicks = await loadTicksForWindow(effectivePodId, mId, resolvedDate, startMs, endMs, serverName);
  if (rawTicks.length === 0 && effectivePodId !== pId) {
    rawTicks = await loadTicksForWindow(pId, mId, resolvedDate, startMs, endMs, serverName);
  }

  // Fallback: If no ticks found, check with alternate Indonesian timezone offset (WIB vs WITA ±1 hour)
  if (rawTicks.length === 0) {
    const tzOffset = getTimezoneOffsetString(APP_TIMEZONE || 'Asia/Makassar');
    const isWITA = tzOffset === '+08:00';
    const shiftMs = isWITA ? 3600000 : -3600000;
    const altStart = startMs + shiftMs;
    const altEnd = endMs + shiftMs;
    rawTicks = await loadTicksForWindow(effectivePodId, mId, resolvedDate, altStart, altEnd, serverName);
    if (rawTicks.length === 0 && effectivePodId !== pId) {
      rawTicks = await loadTicksForWindow(pId, mId, resolvedDate, altStart, altEnd, serverName);
    }
  }

  const incidents = await loadIncidentsForWindow(effectivePodId, mId, resolvedDate, startMs, endMs);

  // 4. Compute intervals, deltas, and gaps
  const ticksWithDelta = [];
  const gaps = [];
  let detectedPort = null;
  let lastKnownHb = null;

  for (let i = 0; i < rawTicks.length; i++) {
    const curr = rawTicks[i];
    if (curr.port && !detectedPort) detectedPort = curr.port;

    let deltaSec = null;
    let deltaHb = null;
    let status = 'NORMAL';
    let postDeadType = null;
    let postDeadLabel = null;

    if (i > 0) {
      const prev = rawTicks[i - 1];
      deltaSec = Math.round(((curr.ts - prev.ts) / 1000) * 100) / 100;
    }

    if (curr.hb !== null && curr.hb !== undefined) {
      if (lastKnownHb !== null && lastKnownHb !== undefined) {
        deltaHb = curr.hb - lastKnownHb;
      }
    }

    if (i > 0) {
      const prev = rawTicks[i - 1];
      const prevHb = (prev.hb !== null && prev.hb !== undefined) ? prev.hb : lastKnownHb;

      const isReset = (curr.hb !== null && curr.hb !== undefined && curr.hb <= 2) ||
        (prevHb !== null && prevHb !== undefined && curr.hb !== null && curr.hb !== undefined && curr.hb < prevHb);
      const isJumped = !isReset && deltaHb !== null && deltaHb > 5;
      const isResumed = !isReset && !isJumped && (deltaHb !== null && deltaHb >= 0 && deltaHb <= 5);

      if (deltaSec >= deadSec) {
        status = 'GAP_DEAD';
        postDeadType = isReset ? 'RESET' : isJumped ? 'LOMPAT' : 'BERLANJUT';
        postDeadLabel = isReset
          ? 'RESET (Mulai Dari 0)'
          : isJumped
            ? `LOMPAT (+${deltaHb} Detak)`
            : 'BERLANJUT (Kontinu)';

        gaps.push({
          id: `gap_${prev.ts}_${curr.ts}`,
          startTs: prev.ts,
          endTs: curr.ts,
          startTime: formatTimeOnly(prev.ts),
          endTime: formatTimeOnly(curr.ts),
          durationSec: deltaSec,
          beforeHb: prevHb !== undefined ? prevHb : null,
          afterHb: curr.hb !== undefined ? curr.hb : null,
          hbDiff: deltaHb,
          postDeadType,
          postDeadLabel,
          port: curr.port || prev.port || detectedPort
        });
      } else if (isJumped) {
        // Counter lompat / packet drop (> 5 detak hilang di perjalanan)
        // Contoh: dari hb 46922 ke 46968 (+46 detak terlewat)
        status = 'GAP_JUMP';
        postDeadType = 'LOMPAT';
        postDeadLabel = `LOMPAT (+${deltaHb} Detak)`;

        gaps.push({
          id: `jump_${prev.ts}_${curr.ts}`,
          startTs: prev.ts,
          endTs: curr.ts,
          startTime: formatTimeOnly(prev.ts),
          endTime: formatTimeOnly(curr.ts),
          durationSec: deltaSec,
          beforeHb: prevHb !== undefined ? prevHb : null,
          afterHb: curr.hb !== undefined ? curr.hb : null,
          hbDiff: deltaHb,
          postDeadType,
          postDeadLabel,
          port: curr.port || prev.port || detectedPort
        });
      } else if (isReset) {
        // Counter reset cepat ke 0/1 (< deadSec)
        status = 'RESET';
        postDeadType = 'RESET';
        postDeadLabel = 'RESET (Mulai Dari 0)';

        gaps.push({
          id: `reset_${prev.ts}_${curr.ts}`,
          startTs: prev.ts,
          endTs: curr.ts,
          startTime: formatTimeOnly(prev.ts),
          endTime: formatTimeOnly(curr.ts),
          durationSec: deltaSec,
          beforeHb: prevHb !== undefined ? prevHb : null,
          afterHb: curr.hb !== undefined ? curr.hb : null,
          hbDiff: deltaHb,
          postDeadType,
          postDeadLabel,
          port: curr.port || prev.port || detectedPort
        });
      } else if (deltaSec >= 3.0) {
        status = 'GAP_LAG';
      } else if (deltaHb === 0 && deltaSec >= frozenSec) {
        status = 'FROZEN';
      }
    }

    if (curr.hb !== null && curr.hb !== undefined) {
      lastKnownHb = curr.hb;
    }

    ticksWithDelta.push({
      index: i + 1,
      ts: curr.ts,
      date: formatFullDateTime(curr.ts),
      time: formatTimeOnly(curr.ts),
      hb: curr.hb !== undefined ? curr.hb : null,
      deltaSec,
      deltaHb,
      status,
      postDeadType,
      postDeadLabel,
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
      timezone: 'WITA (UTC+8)',
      timezoneName: WITA_TIMEZONE,
      dateStr: resolvedDate,
      targetTimestamp: targetMs,
      targetTimeStr: formatDateTimeWITA(targetMs),
      windowMinutes: winMin,
      windowStart: formatDateTimeWITA(startMs),
      windowEnd: formatDateTimeWITA(endMs),
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
          timeFormatted: formatDateTimeWITA(ts)
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
            timeFormatted: formatDateTimeWITA(ts)
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
  parseTargetTime,
  classifyRootCauseHeuristic
};
