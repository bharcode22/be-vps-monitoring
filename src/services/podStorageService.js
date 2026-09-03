const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { dbAsync } = require('./db');

// Domain services under ./podStorage/ (Storage Manager & Content Manager)
const {
  executeCommand,
  getPodStorageSummary
} = require('./podStorage/podDiskService');

const {
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  detectPodRogueFiles,
  downloadS3FilesToPod,
  checkPodFileIntegrity
} = require('./podStorage/podMediaScannerService');

const {
  getMimeType,
  streamPodPhysicalFile
} = require('./podStorage/podMediaStreamService');

const {
  inspectPodDockerStorage,
  cleanPodDockerStorage
} = require('./podStorage/podDockerStorageService');

// Base directory for pod-centric storage
const BASE_STORAGE_DIR = path.join(__dirname, '../data/pod_storage');
const PODS_DIR = path.join(BASE_STORAGE_DIR, 'pods');
const CONFIG_DIR = path.join(BASE_STORAGE_DIR, 'config');
const FLEET_SNAPSHOT_FILE = path.join(BASE_STORAGE_DIR, '_fleet_snapshot.json');

// Memory cache for recent events ring buffer (fast API lookups)
const recentFleetEvents = [];
const MAX_RECENT_EVENTS = 200;

// Memory buffer for recent raw heartbeat ticks per pod: Map<podId, Array<rawTick>>
const recentRawHbBuffer = new Map();
const MAX_RAW_HB_MEMORY_PER_POD = 300;

// High-performance write stream cache per pod & date
const activeHbStreamMap = new Map();

// Memory cache for pod server name mapping: Map<podId, serverName>
const podNameCache = new Map();

/**
 * Sanitize server name for directory naming (e.g. "POD 36" -> "POD_36")
 */
function sanitizeServerName(name) {
  if (!name) return null;
  return String(name).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
}

/**
 * Check if a legacy directory actually exists with exact case-sensitive match
 * (Prevents case-insensitive collision on macOS/Windows, e.g. 'pod_31' matching 'POD_31')
 */
function exactLegacyFolderExists(folderName) {
  if (!folderName || !fs.existsSync(PODS_DIR)) return false;
  try {
    const entries = fs.readdirSync(PODS_DIR);
    return entries.includes(folderName);
  } catch (_) {
    return false;
  }
}

/**
 * Register / update pod server name in memory cache
 */
function registerPodName(podId, name) {
  if (!podId || !name) return;
  podNameCache.set(Number(podId), String(name).trim());
}

/**
 * Resolve folder directory for a podId:
 * Uses sanitized server name (e.g. POD_36) from cache/DB.
 * Fallback to legacy pod_{id} directory if it exists and new directory doesn't exist yet.
 */
function getPodDir(podId, explicitName = null) {
  const id = Number(podId);
  if (explicitName) {
    registerPodName(id, explicitName);
  }

  const rawName = explicitName || podNameCache.get(id);
  const sanitized = sanitizeServerName(rawName);

  // 1. If sanitized name exists and its directory exists in PODS_DIR, use it
  if (sanitized) {
    const targetDir = path.join(PODS_DIR, sanitized);
    if (fs.existsSync(targetDir)) {
      return targetDir;
    }
  }

  // 2. For new writes, if sanitized name is known, use sanitized name directory (e.g. POD_36)
  if (sanitized) {
    return path.join(PODS_DIR, sanitized);
  }

  // 3. Fallback check for old naming: 'pod_15'
  const legacyDir = path.join(PODS_DIR, `pod_${id}`);
  return legacyDir;
}

/**
 * Initialize directory structure on startup
 */
function initPodStorage() {
  try {
    if (!fs.existsSync(BASE_STORAGE_DIR)) {
      fs.mkdirSync(BASE_STORAGE_DIR, { recursive: true });
    }
    if (!fs.existsSync(PODS_DIR)) {
      fs.mkdirSync(PODS_DIR, { recursive: true });
    }
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
    console.log('📁 Pod Storage System initialized at:', BASE_STORAGE_DIR);

    // Populate server names from database asynchronously
    if (dbAsync && typeof dbAsync.all === 'function') {
      dbAsync.all('SELECT id, name FROM servers')
        .then(rows => {
          if (Array.isArray(rows)) {
            for (const r of rows) {
              if (r.id && r.name) {
                registerPodName(r.id, r.name);
              }
            }
          }
        })
        .catch(() => {});
    }
  } catch (err) {
    console.error('⚠️ Failed to initialize Pod Storage System:', err.message);
  }
}

// Auto-run initialization
initPodStorage();

/**
 * Ensure directory for specific pod exists (events & heartbeats subdirectories)
 */
function ensurePodDir(podId, explicitName = null) {
  const podDir = getPodDir(podId, explicitName);
  const eventsDir = path.join(podDir, 'events');
  const hbDir = path.join(podDir, 'heartbeats');

  if (!fs.existsSync(eventsDir)) {
    fs.mkdirSync(eventsDir, { recursive: true });
  }
  if (!fs.existsSync(hbDir)) {
    fs.mkdirSync(hbDir, { recursive: true });
  }

  return { podDir, eventsDir, hbDir };
}

/**
 * Get filepath for a pod's daily JSON-Lines event log
 */
function getPodEventsLogPath(podId, dateStr = null, explicitName = null) {
  const { eventsDir } = ensurePodDir(podId, explicitName);
  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const targetFile = path.join(eventsDir, `${targetDate}.jsonl`);

  // Fallback to legacy folder if file not yet in new folder and legacy folder strictly exists
  if (!fs.existsSync(targetFile)) {
    if (exactLegacyFolderExists(`pod_${podId}`)) {
      const legacyPath = path.join(PODS_DIR, `pod_${podId}`, 'events', `${targetDate}.jsonl`);
      if (fs.existsSync(legacyPath)) {
        return legacyPath;
      }
    }
  }

  return targetFile;
}

/**
 * Get filepath for a pod's daily JSON-Lines raw heartbeat stream
 */
function getPodHeartbeatsLogPath(podId, dateStr = null, explicitName = null) {
  const { hbDir } = ensurePodDir(podId, explicitName);
  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const targetFile = path.join(hbDir, `${targetDate}.jsonl`);

  // Fallback to legacy folder if file not yet in new folder and legacy folder strictly exists
  if (!fs.existsSync(targetFile)) {
    if (exactLegacyFolderExists(`pod_${podId}`)) {
      const legacyPath = path.join(PODS_DIR, `pod_${podId}`, 'heartbeats', `${targetDate}.jsonl`);
      if (fs.existsSync(legacyPath)) {
        return legacyPath;
      }
    }
  }

  return targetFile;
}

/**
 * Get or create write stream for raw heartbeat logs
 */
function getHbWriteStream(podId, dateStr, serverName = null) {
  const key = `${podId}_${dateStr}`;
  if (!activeHbStreamMap.has(key)) {
    // For writing new ticks, ensure new sanitized server directory is used
    const { hbDir } = ensurePodDir(podId, serverName);
    const targetDate = dateStr || new Date().toISOString().split('T')[0];
    const filePath = path.join(hbDir, `${targetDate}.jsonl`);
    const stream = fs.createWriteStream(filePath, { flags: 'a', encoding: 'utf8' });
    activeHbStreamMap.set(key, stream);

    // Auto-clean stream map if it grows too large (e.g. across midnight date change)
    if (activeHbStreamMap.size > 100) {
      for (const [k, s] of activeHbStreamMap.entries()) {
        if (!k.endsWith(dateStr)) {
          s.end();
          activeHbStreamMap.delete(k);
        }
      }
    }
  }
  return activeHbStreamMap.get(key);
}

/**
 * Record a raw heartbeat tick from MQTT into daily JSON-Lines stream
 * @param {Object} tickObj { podId, serverName, moduleId, hb, port, timestamp }
 */
function recordRawHeartbeatTick({ podId, serverName = null, moduleId, hb, port = null, timestamp = Date.now() }) {
  if (!podId || !moduleId) return;

  if (serverName) {
    registerPodName(podId, serverName);
  }

  const now = timestamp || Date.now();
  const dateStr = new Date(now).toISOString().split('T')[0];

  const rawTick = {
    ts: now,
    isoTime: new Date(now).toISOString(),
    podId: Number(podId),
    modId: Number(moduleId),
    hb: (hb !== null && hb !== undefined && !isNaN(Number(hb))) ? Number(hb) : null,
    port: port || null
  };

  // 1. In-memory buffer for real-time live inspection
  if (!recentRawHbBuffer.has(podId)) {
    recentRawHbBuffer.set(podId, []);
  }
  const buf = recentRawHbBuffer.get(podId);
  buf.unshift(rawTick);
  if (buf.length > MAX_RAW_HB_MEMORY_PER_POD) {
    buf.pop();
  }

  // 2. High-performance non-blocking append to daily .jsonl file in pod folder
  try {
    const stream = getHbWriteStream(podId, dateStr, serverName);
    if (stream && stream.writable) {
      stream.write(JSON.stringify(rawTick) + '\n');
    }
  } catch (err) {
    console.warn(`⚠️ Error streaming raw heartbeat tick for POD ${podId}:`, err.message);
  }

  return rawTick;
}

/**
 * Record a structured event into a Pod's daily .jsonl file
 * @param {Object} eventObj
 * { podId, podName, moduleId, moduleName, eventType, message, lastHb, downtimeSeconds, data, timestamp }
 */
function recordPodEvent(eventObj) {
  if (!eventObj || !eventObj.podId) return;

  if (eventObj.podName) {
    registerPodName(eventObj.podId, eventObj.podName);
  }

  const now = eventObj.timestamp || Date.now();
  const dateStr = new Date(now).toISOString().split('T')[0];
  const { eventsDir } = ensurePodDir(eventObj.podId, eventObj.podName);
  const filePath = path.join(eventsDir, `${dateStr}.jsonl`);

  const entry = {
    id: `evt_${now}_${Math.random().toString(36).slice(2, 6)}`,
    podId: Number(eventObj.podId),
    podName: eventObj.podName || `POD ${eventObj.podId}`,
    moduleId: eventObj.moduleId ? Number(eventObj.moduleId) : null,
    moduleName: eventObj.moduleName || null,
    eventType: eventObj.eventType || 'INFO', // 'DEAD', 'FROZEN', 'RECOVERED', 'OCCUPIED_CHANGE', 'CMD_EXECUTED'
    message: eventObj.message || '',
    lastHb: eventObj.lastHb !== undefined ? eventObj.lastHb : null,
    downtimeSeconds: eventObj.downtimeSeconds || 0,
    data: eventObj.data || null,
    timestamp: now,
    isoTime: new Date(now).toISOString()
  };

  // 1. Append to ring buffer for fleet overview
  recentFleetEvents.unshift(entry);
  if (recentFleetEvents.length > MAX_RECENT_EVENTS) {
    recentFleetEvents.pop();
  }

  // 2. Append asynchronously to pod's daily .jsonl file
  const jsonLine = JSON.stringify(entry) + '\n';
  fs.appendFile(filePath, jsonLine, 'utf8', (err) => {
    if (err) {
      console.warn(`⚠️ Error appending pod event log for POD ${eventObj.podId}:`, err.message);
    }
  });

  return entry;
}

/**
 * Save / update latest state snapshot for a specific pod in state.json
 */
function savePodState(podId, stateData) {
  if (!podId || !stateData) return;
  try {
    if (stateData.name) {
      registerPodName(podId, stateData.name);
    }
    const { podDir } = ensurePodDir(podId, stateData.name);
    const stateFile = path.join(podDir, 'state.json');
    const content = {
      podId: Number(podId),
      updatedAt: new Date().toISOString(),
      ...stateData
    };
    fs.writeFileSync(stateFile, JSON.stringify(content, null, 2), 'utf8');
  } catch (err) {
    console.warn(`⚠️ Error saving state for POD ${podId}:`, err.message);
  }
}

/**
 * Read latest state snapshot for a specific pod
 */
function getPodState(podId) {
  if (!podId) return null;
  try {
    const { podDir } = ensurePodDir(podId);
    const stateFile = path.join(podDir, 'state.json');
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      return JSON.parse(raw);
    }
    // Fallback legacy folder
    if (exactLegacyFolderExists(`pod_${podId}`)) {
      const legacyState = path.join(PODS_DIR, `pod_${podId}`, 'state.json');
      if (fs.existsSync(legacyState)) {
        const raw = fs.readFileSync(legacyState, 'utf8');
        return JSON.parse(raw);
      }
    }
  } catch (err) {
    console.warn(`⚠️ Error reading state for POD ${podId}:`, err.message);
  }
  return null;
}

/**
 * Get daily events for a specific pod (parsed from events/YYYY-MM-DD.jsonl)
 */
function getPodEvents(podId, dateStr = null) {
  if (!podId) return [];
  try {
    const filePath = getPodEventsLogPath(podId, dateStr);
    if (!fs.existsSync(filePath)) return [];

    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    const events = [];

    for (const line of lines) {
      try {
        events.push(JSON.parse(line));
      } catch (_) {}
    }

    return events.reverse(); // Latest events first
  } catch (err) {
    console.warn(`⚠️ Error reading pod events for POD ${podId}:`, err.message);
    return [];
  }
}

/**
 * Helper to parse time string or timestamp into epoch milliseconds
 * @param {string|number} timeVal - e.g. "08:00", "12:30:15", ISO string, or timestamp ms
 * @param {string} targetDate - "YYYY-MM-DD"
 * @param {boolean} isEnd - whether this is the end of the range
 */
function parseTimeToMs(timeVal, targetDate, isEnd = false) {
  if (timeVal === null || timeVal === undefined || timeVal === '') return null;
  if (typeof timeVal === 'number' && !isNaN(timeVal)) return timeVal;
  const str = String(timeVal).trim();
  if (!str) return null;
  if (/^\d{10,13}$/.test(str)) {
    const num = Number(str);
    return num < 1e11 ? num * 1000 : num;
  }
  if (/^\d{2}:\d{2}$/.test(str)) {
    const sec = isEnd ? ':59.999' : ':00.000';
    const d = new Date(`${targetDate}T${str}${sec}`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  if (/^\d{2}:\d{2}:\d{2}$/.test(str)) {
    const ms = isEnd ? '.999' : '.000';
    const d = new Date(`${targetDate}T${str}${ms}`);
    if (!isNaN(d.getTime())) return d.getTime();
  }
  const parsed = Date.parse(str);
  return !isNaN(parsed) ? parsed : null;
}

/**
 * Get raw heartbeat stream for a specific pod (parsed from heartbeats/YYYY-MM-DD.jsonl)
 * Supports pagination, module filtering, time window filtering, and memory/disk sources
 */
async function getPodHeartbeatStream(podIdOrOptions, dateStr = null, limit = 500) {
  let podId, moduleId, startTime, endTime, source;
  if (typeof podIdOrOptions === 'object' && podIdOrOptions !== null) {
    podId = podIdOrOptions.podId;
    dateStr = podIdOrOptions.dateStr || podIdOrOptions.date || null;
    moduleId = podIdOrOptions.moduleId || null;
    startTime = podIdOrOptions.startTime || null;
    endTime = podIdOrOptions.endTime || null;
    limit = parseInt(podIdOrOptions.limit, 10) || 500;
    source = podIdOrOptions.source || 'auto';
  } else {
    podId = podIdOrOptions;
    source = 'auto';
  }

  if (!podId) return [];

  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const today = new Date().toISOString().split('T')[0];
  const isToday = targetDate === today;
  const modIdNum = (moduleId !== null && moduleId !== undefined && moduleId !== '' && moduleId !== 'ALL')
    ? Number(moduleId)
    : null;

  // 1. Fast path: in-memory buffer if 'live' requested or auto with no specific time filter on today
  if ((source === 'live' || (source === 'auto' && isToday && !startTime && !endTime && modIdNum === null)) && recentRawHbBuffer.has(Number(podId))) {
    const mem = recentRawHbBuffer.get(Number(podId));
    if (mem && mem.length > 0) {
      let result = mem;
      if (modIdNum !== null) {
        result = result.filter(t => t.modId === modIdNum);
      }
      return result.slice(0, limit);
    }
  }

  // 2. Read from JSON-Lines file using readline stream
  const filePath = getPodHeartbeatsLogPath(podId, targetDate);
  if (!fs.existsSync(filePath)) return [];

  const startMs = parseTimeToMs(startTime, targetDate, false);
  const endMs = parseTimeToMs(endTime, targetDate, true);

  return new Promise((resolve) => {
    try {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const matches = [];

      rl.on('line', (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        try {
          const tick = JSON.parse(trimmed);

          // Module filter
          if (modIdNum !== null && tick.modId !== modIdNum) {
            return;
          }

          // Time filter
          if (startMs !== null && tick.ts < startMs) {
            return;
          }
          if (endMs !== null && tick.ts > endMs) {
            return;
          }

          matches.push(tick);
          // Sliding window to avoid unbounded memory growth
          if (matches.length > limit * 2) {
            matches.splice(0, matches.length - limit);
          }
        } catch (_) {}
      });

      rl.on('close', () => {
        // Return latest matching ticks first
        resolve(matches.slice(-limit).reverse());
      });

      rl.on('error', (err) => {
        console.warn(`⚠️ Error streaming raw heartbeats for POD ${podId}:`, err.message);
        resolve(matches.slice(-limit).reverse());
      });
    } catch (err) {
      console.warn(`⚠️ Error initiating heartbeat stream for POD ${podId}:`, err.message);
      resolve([]);
    }
  });
}

/**
 * Get list of available dates with recorded heartbeat logs for a pod
 */
function getPodLogDates(podId) {
  if (!podId) return [];
  try {
    const { hbDir } = ensurePodDir(podId);
    const dateSet = new Set();

    // 1. Read from resolved dir
    if (fs.existsSync(hbDir)) {
      const files = fs.readdirSync(hbDir);
      files.filter(f => f.endsWith('.jsonl')).forEach(f => dateSet.add(f.replace('.jsonl', '')));
    }

    // 2. Read from legacy dir if strictly exists
    if (exactLegacyFolderExists(`pod_${podId}`)) {
      const legacyHbDir = path.join(PODS_DIR, `pod_${podId}`, 'heartbeats');
      if (fs.existsSync(legacyHbDir)) {
        const files = fs.readdirSync(legacyHbDir);
        files.filter(f => f.endsWith('.jsonl')).forEach(f => dateSet.add(f.replace('.jsonl', '')));
      }
    }

    return Array.from(dateSet).sort().reverse();
  } catch (err) {
    console.warn(`⚠️ Error reading log dates for POD ${podId}:`, err.message);
    return [];
  }
}

/**
 * Format bytes to readable string (e.g. 1.2 MB, 450 KB)
 */
function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Get full list of physical files in pod_storage for a given pod
 */
function getPodStorageFilesList(podId) {
  if (!podId) return { success: false, error: 'podId required' };
  const id = Number(podId);
  const { podDir } = ensurePodDir(id);
  const files = [];

  const rawName = podNameCache.get(id);
  const sanitized = sanitizeServerName(rawName) || `pod_${id}`;

  function scanDirectory(dirPath, subCategory, type) {
    if (!fs.existsSync(dirPath)) return;
    try {
      const items = fs.readdirSync(dirPath);
      for (const item of items) {
        if (!item.endsWith('.jsonl') && !item.endsWith('.json')) continue;
        const fullPath = path.join(dirPath, item);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            files.push({
              name: item,
              date: item.replace(/\.(jsonl|json)$/, ''),
              type,
              category: subCategory,
              relativePath: path.relative(PODS_DIR, fullPath),
              sizeBytes: stat.size,
              sizeFormatted: formatBytes(stat.size),
              modifiedAt: stat.mtime.toISOString()
            });
          }
        } catch (_) {}
      }
    } catch (_) {}
  }

  // Scan current resolved folder
  const currentHbDir = path.join(podDir, 'heartbeats');
  const currentEventsDir = path.join(podDir, 'events');
  const currentStateFile = path.join(podDir, 'state.json');

  scanDirectory(currentHbDir, 'Detak Modul (Raw Heartbeats)', 'heartbeats');
  scanDirectory(currentEventsDir, 'Insiden & Peristiwa', 'events');
  if (fs.existsSync(currentStateFile)) {
    try {
      const stat = fs.statSync(currentStateFile);
      files.push({
        name: 'state.json',
        date: new Date(stat.mtime).toISOString().split('T')[0],
        type: 'state',
        category: 'Snapshot Status Terakhir',
        relativePath: path.relative(PODS_DIR, currentStateFile),
        sizeBytes: stat.size,
        sizeFormatted: formatBytes(stat.size),
        modifiedAt: stat.mtime.toISOString()
      });
    } catch (_) {}
  }

  // Scan legacy folder if different and strictly exists with exact casing
  const legacyFolderName = `pod_${id}`;
  if (exactLegacyFolderExists(legacyFolderName)) {
    const legacyDir = path.join(PODS_DIR, legacyFolderName);
    scanDirectory(path.join(legacyDir, 'heartbeats'), 'Detak Modul (Legacy)', 'heartbeats');
    scanDirectory(path.join(legacyDir, 'events'), 'Insiden & Peristiwa (Legacy)', 'events');
    const legacyState = path.join(legacyDir, 'state.json');
    if (fs.existsSync(legacyState) && !files.some(f => f.name === 'state.json')) {
      try {
        const stat = fs.statSync(legacyState);
        files.push({
          name: 'state.json (legacy)',
          date: new Date(stat.mtime).toISOString().split('T')[0],
          type: 'state',
          category: 'Snapshot Status Terakhir (Legacy)',
          relativePath: path.relative(PODS_DIR, legacyState),
          sizeBytes: stat.size,
          sizeFormatted: formatBytes(stat.size),
          modifiedAt: stat.mtime.toISOString()
        });
      } catch (_) {}
    }
  }

  // Sort by date/mtime descending
  files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

  const totalSize = files.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);

  return {
    success: true,
    podId: id,
    serverName: rawName || `POD ${id}`,
    folderName: sanitized,
    storagePath: `pods/${sanitized}`,
    totalFiles: files.length,
    totalSizeBytes: totalSize,
    totalSizeFormatted: formatBytes(totalSize),
    files
  };
}

/**
 * Stream heartbeats to HTTP response for direct file download
 */
function streamPodHeartbeatsDownload({
  podId,
  serverName = null,
  dateStr = null,
  format = 'json',
  moduleId = null,
  startTime = null,
  endTime = null,
  res
}) {
  const targetDate = dateStr || new Date().toISOString().split('T')[0];
  const filePath = getPodHeartbeatsLogPath(podId, targetDate);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: `Berkas log detak tanggal ${targetDate} tidak ditemukan.` });
  }

  const safeServerName = (serverName || `server_${podId}`).replace(/[^a-zA-Z0-9_-]/g, '_').toLowerCase();
  const modIdNum = (moduleId !== null && moduleId !== undefined && moduleId !== '' && moduleId !== 'ALL')
    ? Number(moduleId)
    : null;
  const startMs = parseTimeToMs(startTime, targetDate, false);
  const endMs = parseTimeToMs(endTime, targetDate, true);
  const hasFilters = modIdNum !== null || startMs !== null || endMs !== null;

  // Fast direct stream if format is jsonl and no filters
  if (format === 'jsonl' && !hasFilters) {
    return res.download(filePath, `${safeServerName}_raw_heartbeats_${targetDate}.jsonl`);
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  if (format === 'json') {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeServerName}_heartbeats_${targetDate}.json"`);
    res.write('[\n');

    let isFirst = true;

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const tick = JSON.parse(trimmed);
        if (modIdNum !== null && tick.modId !== modIdNum) return;
        if (startMs !== null && tick.ts < startMs) return;
        if (endMs !== null && tick.ts > endMs) return;

        if (!isFirst) {
          res.write(',\n');
        } else {
          isFirst = false;
        }
        res.write(JSON.stringify(tick));
      } catch (_) {}
    });

    rl.on('close', () => {
      res.write('\n]\n');
      res.end();
    });

    rl.on('error', (err) => {
      console.warn(`⚠️ Error downloading heartbeats as JSON for POD ${podId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      } else {
        res.end();
      }
    });
  } else {
    // format is jsonl with filters
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${safeServerName}_raw_heartbeats_${targetDate}.jsonl"`);

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      try {
        const tick = JSON.parse(trimmed);
        if (modIdNum !== null && tick.modId !== modIdNum) return;
        if (startMs !== null && tick.ts < startMs) return;
        if (endMs !== null && tick.ts > endMs) return;

        res.write(line + '\n');
      } catch (_) {}
    });

    rl.on('close', () => {
      res.end();
    });

    rl.on('error', (err) => {
      console.warn(`⚠️ Error downloading heartbeats as JSONL for POD ${podId}:`, err.message);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: err.message });
      } else {
        res.end();
      }
    });
  }
}

/**
 * Get recent incidents across all pods
 */
function getRecentFleetIncidents(limit = 50) {
  return recentFleetEvents.slice(0, limit);
}

/**
 * Save entire fleet-wide snapshot to file (persisted on server reload)
 */
function saveFleetSnapshot(snapshot) {
  if (!snapshot) return;
  try {
    initPodStorage();
    fs.writeFileSync(FLEET_SNAPSHOT_FILE, JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ Error saving fleet snapshot to file:', err.message);
  }
}

/**
 * Load fleet-wide snapshot from file on startup
 */
function getFleetSnapshot() {
  try {
    if (fs.existsSync(FLEET_SNAPSHOT_FILE)) {
      const raw = fs.readFileSync(FLEET_SNAPSHOT_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch (err) {
    console.warn('⚠️ Error loading fleet snapshot from file:', err.message);
  }
  return {};
}

/**
 * Auto-purge event & heartbeat logs older than retention period (default: 14 days)
 */
function autoPurgeOldLogs(retentionDays = 14) {
  try {
    if (!fs.existsSync(PODS_DIR)) return;

    const cutoffTime = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const podFolders = fs.readdirSync(PODS_DIR);

    let purgedCount = 0;
    for (const folder of podFolders) {
      const podDir = path.join(PODS_DIR, folder);

      // Clean events/ and heartbeats/ subdirectories
      for (const sub of ['events', 'heartbeats']) {
        const subDir = path.join(podDir, sub);
        if (fs.existsSync(subDir)) {
          const files = fs.readdirSync(subDir);
          for (const file of files) {
            if (file.endsWith('.jsonl')) {
              const filePath = path.join(subDir, file);
              const stat = fs.statSync(filePath);
              if (stat.mtimeMs < cutoffTime) {
                fs.unlinkSync(filePath);
                purgedCount++;
              }
            }
          }
        }
      }
    }

    if (purgedCount > 0) {
      console.log(`🧹 Purged ${purgedCount} expired JSONL log files older than ${retentionDays} days.`);
    }
  } catch (err) {
    console.warn('⚠️ Error running auto purge for pod logs:', err.message);
  }
}

// Run auto purge once every 24 hours
setInterval(() => autoPurgeOldLogs(14), 24 * 60 * 60 * 1000);

module.exports = {
  // Heartbeat & Incident Logging Storage
  initPodStorage,
  registerPodName,
  sanitizeServerName,
  recordRawHeartbeatTick,
  recordPodEvent,
  savePodState,
  getPodState,
  getPodEvents,
  getPodHeartbeatStream,
  getPodLogDates,
  getPodStorageFilesList,
  streamPodHeartbeatsDownload,
  getPodEventsLogPath,
  getPodHeartbeatsLogPath,
  getRecentFleetIncidents,
  saveFleetSnapshot,
  getFleetSnapshot,
  autoPurgeOldLogs,

  // Storage Manager & Content Manager (Facade)
  executeCommand,
  getPodStorageSummary,
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  getMimeType,
  streamPodPhysicalFile,
  inspectPodDockerStorage,
  cleanPodDockerStorage,
  detectPodRogueFiles,
  downloadS3FilesToPod,
  checkPodFileIntegrity
};
