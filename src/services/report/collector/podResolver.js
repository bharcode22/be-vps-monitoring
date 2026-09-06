const fs = require('fs');
const path = require('path');
const { registerPodName } = require('../../podStorageService');
const { queryPodDb } = require('./podDbClient');

function getPodStorageBaseDir() {
  const candidate1 = path.resolve(__dirname, '../../../data/pod_storage/pods'); // backend/src/data/pod_storage/pods
  if (fs.existsSync(candidate1)) return candidate1;

  const candidate2 = path.resolve(__dirname, '../../../../data/pod_storage/pods'); // backend/data/pod_storage/pods
  if (fs.existsSync(candidate2)) return candidate2;

  return candidate1;
}

/**
 * Resolve physical directory under pod_storage/pods for a given pod server
 */
function resolvePodStorageDir(podServer) {
  const storageBaseDir = getPodStorageBaseDir();

  if (!fs.existsSync(storageBaseDir)) {
    return {
      found: false,
      error: `Direktori penyimpanan pod ${storageBaseDir} tidak ditemukan.`
    };
  }

  const entries = fs.readdirSync(storageBaseDir);
  let matchedDir = null;
  let matchedFolderName = null;
  let matchedBy = null;
  let stateSnapshot = null;

  // 1. Check state.json inside each subfolder (exact match by podId, name, or host)
  for (const entry of entries) {
    const entryPath = path.join(storageBaseDir, entry);
    try {
      if (!fs.statSync(entryPath).isDirectory()) continue;
      const stateFile = path.join(entryPath, 'state.json');
      if (fs.existsSync(stateFile)) {
        const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
        if (state.podId && Number(state.podId) === Number(podServer.id)) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `state.json (podId: ${state.podId})`;
          stateSnapshot = state;
          break;
        }
        if (state.name && state.name.trim().toLowerCase() === String(podServer.name).trim().toLowerCase()) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `state.json (name: ${state.name})`;
          stateSnapshot = state;
          break;
        }
        if (state.host && podServer.host && state.host.trim() === String(podServer.host).trim()) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `state.json (host: ${state.host})`;
          stateSnapshot = state;
          break;
        }
      }
    } catch (_) { }
  }

  // 2. Exact sanitized name match (e.g. 'POD 36' -> 'POD_36', 'POD RIG 30' -> 'POD_RIG_30', 'POD LTV' -> 'POD_LTV')
  if (!matchedDir) {
    const sanitized = String(podServer.name).trim().replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_');
    for (const entry of entries) {
      const entryPath = path.join(storageBaseDir, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
        if (entry.toLowerCase() === sanitized.toLowerCase()) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `sanitizedName (${entry})`;
          break;
        }
      } catch (_) { }
    }
  }

  // 3. Exact legacy folder match (e.g. 'Pod_8', 'pod_8')
  if (!matchedDir) {
    for (const entry of entries) {
      const entryPath = path.join(storageBaseDir, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
        if (entry === `pod_${podServer.id}` || entry === `Pod_${podServer.id}`) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `legacyFolder (${entry})`;
          break;
        }
      } catch (_) { }
    }
  }

  // 4. Try name without spaces (e.g. 'POD36')
  if (!matchedDir) {
    const noSpaces = String(podServer.name).replace(/\s+/g, '').toLowerCase();
    for (const entry of entries) {
      const entryPath = path.join(storageBaseDir, entry);
      try {
        if (!fs.statSync(entryPath).isDirectory()) continue;
        if (entry.replace(/\s+/g, '').toLowerCase() === noSpaces) {
          matchedDir = entryPath;
          matchedFolderName = entry;
          matchedBy = `noSpacesName (${entry})`;
          break;
        }
      } catch (_) { }
    }
  }

  // If found and stateSnapshot not yet loaded, try reading state.json
  if (matchedDir && !stateSnapshot) {
    const sf = path.join(matchedDir, 'state.json');
    if (fs.existsSync(sf)) {
      try {
        stateSnapshot = JSON.parse(fs.readFileSync(sf, 'utf8'));
      } catch (_) { }
    }
  }

  // Update memory cache in podStorageService
  if (podServer.id && podServer.name && typeof registerPodName === 'function') {
    registerPodName(podServer.id, podServer.name);
  }

  if (!matchedDir) {
    return {
      found: false,
      folderName: null,
      podDir: null,
      relativePath: null,
      matchedBy: null,
      stateSnapshot: null,
      error: `Folder penyimpanan lokal untuk ${podServer.name} tidak ditemukan di ${storageBaseDir}`
    };
  }

  return {
    found: true,
    folderName: matchedFolderName,
    podDir: matchedDir,
    relativePath: `pods/${matchedFolderName}`,
    matchedBy,
    stateSnapshot
  };
}

/**
 * Resolve target POD UUID in Master DB or local POD DB
 */
async function resolvePodId(masterPool, podServer) {
  // 1. Try matching podServer.pod_uuid against pod.id or pod.code
  if (podServer.pod_uuid) {
    try {
      const res = await masterPool.query(
        'SELECT id, name, code, ip_address FROM pod WHERE id::text = $1::text OR code::text = $1::text LIMIT 1',
        [String(podServer.pod_uuid)]
      );
      if (res.rows && res.rows[0]) return res.rows[0].id;
    } catch (_) { }
  }

  // 2. Try matching IP address
  if (podServer.host) {
    try {
      const res = await masterPool.query(
        'SELECT id, name, code, ip_address FROM pod WHERE ip_address = $1 LIMIT 1',
        [podServer.host]
      );
      if (res.rows && res.rows[0]) return res.rows[0].id;
    } catch (_) { }
  }

  // 3. Try matching digits in name or code (e.g. POD 36 -> code 36)
  const digits = (podServer.name.match(/\d+/) || [])[0] || (podServer.code.match(/\d+/) || [])[0];
  if (digits) {
    try {
      const res = await masterPool.query(
        'SELECT id, name, code, ip_address FROM pod WHERE code = $1 OR name ILIKE $2 LIMIT 1',
        [String(digits), `%${digits}%`]
      );
      if (res.rows && res.rows[0]) return res.rows[0].id;
    } catch (_) { }
  }

  // 4. Local query fallback from POD DB
  try {
    const localRows = await queryPodDb(podServer, 'SELECT id FROM pod LIMIT 1');
    if (localRows && localRows[0]) return localRows[0].id;
  } catch (_) { }

  return null;
}

module.exports = {
  getPodStorageBaseDir,
  resolvePodStorageDir,
  resolvePodId
};
