const fs = require('fs');
const path = require('path');

const CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'heartbeat_modules_config.json');
const THRESHOLDS_CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'heartbeat_thresholds_config.json');

/**
 * Load default modules directly from the JSON file
 */
function loadModulesFromJson() {
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const rawData = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(rawData);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed;
      }
    }
  } catch (err) {
    console.error('Error loading modules from JSON:', err.message);
  }
  return [];
}

const DEFAULT_MODULES = loadModulesFromJson();


const DEFAULT_THRESHOLDS = {
  delaySec: 2,
  frozenSec: 10,
  deadSec: 30
};

let cachedModules = null;
let cachedThresholds = null;

/**
 * Ensure the data directory exists
 */
function ensureDataDirExists() {
  const dir = path.dirname(CONFIG_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/**
 * Read the heartbeat modules list from cache or JSON file
 */
function getHeartbeatModulesConfig() {
  if (cachedModules && Array.isArray(cachedModules)) {
    return cachedModules;
  }

  try {
    ensureDataDirExists();
    if (!fs.existsSync(CONFIG_FILE_PATH)) {
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_MODULES, null, 2), 'utf-8');
      cachedModules = DEFAULT_MODULES;
      return DEFAULT_MODULES;
    }

    const rawData = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (Array.isArray(parsed) && parsed.length > 0) {
      cachedModules = parsed;
      return parsed;
    }
    cachedModules = DEFAULT_MODULES;
    return DEFAULT_MODULES;
  } catch (err) {
    console.error('Error reading heartbeat modules config:', err.message);
    cachedModules = DEFAULT_MODULES;
    return DEFAULT_MODULES;
  }
}

/**
 * Helper to get friendly module name by ID (e.g. 501 -> "Manual Control")
 */
function getModuleNameById(moduleId) {
  const modIdNum = Number(moduleId);
  const list = getHeartbeatModulesConfig();
  const found = list.find(m => Number(m.id) === modIdNum);
  return found ? found.name : `Module ${moduleId}`;
}

/**
 * Save updated heartbeat modules list to JSON file
 */
function saveHeartbeatModulesConfig(modules) {
  if (!Array.isArray(modules)) {
    throw new Error('Format data modul harus berupa array.');
  }

  // Validate and sanitize module objects
  const sanitized = modules.map((item, index) => {
    const id = parseInt(item.id, 10);
    if (isNaN(id) || id <= 0) {
      throw new Error(`ID Modul pada baris ${index + 1} tidak valid.`);
    }
    if (!item.name || typeof item.name !== 'string') {
      throw new Error(`Nama modul untuk ID ${id} wajib diisi.`);
    }
    const topic = item.topic ? String(item.topic).trim() : `mod_server/${id}/data`;

    return {
      id,
      name: item.name.trim(),
      topic,
      defaultPort: item.defaultPort ? String(item.defaultPort).trim() : null,
      description: item.description ? String(item.description).trim() : ''
    };
  });

  ensureDataDirExists();
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(sanitized, null, 2), 'utf-8');
  cachedModules = sanitized;
  return sanitized;
}

/**
 * Reset config to default 9 modules
 */
function resetHeartbeatModulesConfig() {
  ensureDataDirExists();
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_MODULES, null, 2), 'utf-8');
  cachedModules = DEFAULT_MODULES;
  return DEFAULT_MODULES;
}

/**
 * Read heartbeat thresholds configuration from cache or JSON file
 */
function getHeartbeatThresholdsConfig() {
  if (cachedThresholds && typeof cachedThresholds === 'object') {
    return cachedThresholds;
  }

  try {
    ensureDataDirExists();
    if (!fs.existsSync(THRESHOLDS_CONFIG_FILE_PATH)) {
      fs.writeFileSync(THRESHOLDS_CONFIG_FILE_PATH, JSON.stringify(DEFAULT_THRESHOLDS, null, 2), 'utf-8');
      cachedThresholds = { ...DEFAULT_THRESHOLDS };
      return cachedThresholds;
    }

    const rawData = fs.readFileSync(THRESHOLDS_CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (parsed && typeof parsed === 'object') {
      const delaySec = Number(parsed.delaySec) || DEFAULT_THRESHOLDS.delaySec;
      const frozenSec = Number(parsed.frozenSec) || DEFAULT_THRESHOLDS.frozenSec;
      const deadSec = Number(parsed.deadSec) || DEFAULT_THRESHOLDS.deadSec;
      cachedThresholds = { delaySec, frozenSec, deadSec };
      return cachedThresholds;
    }
    cachedThresholds = { ...DEFAULT_THRESHOLDS };
    return cachedThresholds;
  } catch (err) {
    console.error('Error reading heartbeat thresholds config:', err.message);
    cachedThresholds = { ...DEFAULT_THRESHOLDS };
    return cachedThresholds;
  }
}

/**
 * Save heartbeat thresholds configuration to JSON file
 */
function saveHeartbeatThresholdsConfig(thresholds) {
  if (!thresholds || typeof thresholds !== 'object') {
    throw new Error('Format data ambang batas harus berupa objek JSON.');
  }

  const delaySec = Math.max(1, parseInt(thresholds.delaySec, 10) || 2);
  const frozenSec = Math.max(delaySec + 1, parseInt(thresholds.frozenSec, 10) || 10);
  const deadSec = Math.max(frozenSec + 1, parseInt(thresholds.deadSec, 10) || 30);

  const sanitized = {
    delaySec,
    frozenSec,
    deadSec
  };

  ensureDataDirExists();
  fs.writeFileSync(THRESHOLDS_CONFIG_FILE_PATH, JSON.stringify(sanitized, null, 2), 'utf-8');
  cachedThresholds = sanitized;
  return sanitized;
}

/**
 * Reset heartbeat thresholds configuration to default
 */
function resetHeartbeatThresholdsConfig() {
  ensureDataDirExists();
  fs.writeFileSync(THRESHOLDS_CONFIG_FILE_PATH, JSON.stringify(DEFAULT_THRESHOLDS, null, 2), 'utf-8');
  cachedThresholds = { ...DEFAULT_THRESHOLDS };
  return cachedThresholds;
}

module.exports = {
  getHeartbeatModulesConfig,
  getModuleNameById,
  saveHeartbeatModulesConfig,
  resetHeartbeatModulesConfig,
  getHeartbeatThresholdsConfig,
  saveHeartbeatThresholdsConfig,
  resetHeartbeatThresholdsConfig,
  DEFAULT_MODULES,
  DEFAULT_THRESHOLDS
};

