const fs = require('fs');
const path = require('path');

const CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'heartbeat_modules_config.json');
const THRESHOLDS_CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'heartbeat_thresholds_config.json');

const DEFAULT_MODULES = [
  {
    id: 501,
    name: 'Manual Control',
    topic: 'mod_server/501/data',
    defaultPort: 'ttyUSB0',
    description: 'Kontrol manual dan override input perangkat'
  },
  {
    id: 502,
    name: 'Chair Module',
    topic: 'mod_server/502/data',
    defaultPort: 'ttyUSB1',
    description: 'Sensor kursi (POB), PEMF, & Schumann'
  },
  {
    id: 503,
    name: 'Lighting Module',
    topic: 'mod_server/503/data',
    defaultPort: 'ttyUSB4',
    description: 'Kontrol RGB, UVC/UVB/UVA, & Strobo'
  },
  {
    id: 504,
    name: 'Olfactory Module',
    topic: 'mod_server/504/data',
    defaultPort: 'ttyUSB5',
    description: 'Modul aroma wewangian & difusi'
  },
  {
    id: 505,
    name: 'Door Module',
    topic: 'mod_server/505/data',
    defaultPort: null,
    description: 'Sensor status pintu & magnetic lock'
  },
  {
    id: 506,
    name: 'AirCon Module',
    topic: 'mod_server/506/data',
    defaultPort: null,
    description: 'Kontrol suhu & ventilasi udara'
  },
  {
    id: 507,
    name: 'Audio Module',
    topic: 'mod_server/507/data',
    defaultPort: 'ttyUSB2',
    description: 'Soundscape, voice guide, & haptic amplifier'
  },
  {
    id: 508,
    name: 'Power Module',
    topic: 'mod_server/508/data',
    defaultPort: 'ttyUSB3',
    description: 'Distribusi daya, relay baterai, & proteksi'
  },
  {
    id: 509,
    name: 'Biofeedback Module',
    topic: 'mod_server/509/data',
    defaultPort: null,
    description: 'Sensor GSR, detak jantung, & biometrik'
  }
];

const DEFAULT_THRESHOLDS = {
  delaySec: 2,
  frozenSec: 10,
  deadSec: 30
};

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
 * Read the heartbeat modules list from JSON file
 */
function getHeartbeatModulesConfig() {
  try {
    ensureDataDirExists();
    if (!fs.existsSync(CONFIG_FILE_PATH)) {
      fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_MODULES, null, 2), 'utf-8');
      return DEFAULT_MODULES;
    }

    const rawData = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed;
    }
    return DEFAULT_MODULES;
  } catch (err) {
    console.error('Error reading heartbeat modules config:', err.message);
    return DEFAULT_MODULES;
  }
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
  return sanitized;
}

/**
 * Reset config to default 9 modules
 */
function resetHeartbeatModulesConfig() {
  ensureDataDirExists();
  fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_MODULES, null, 2), 'utf-8');
  return DEFAULT_MODULES;
}

/**
 * Read heartbeat thresholds configuration from JSON file
 */
function getHeartbeatThresholdsConfig() {
  try {
    ensureDataDirExists();
    if (!fs.existsSync(THRESHOLDS_CONFIG_FILE_PATH)) {
      fs.writeFileSync(THRESHOLDS_CONFIG_FILE_PATH, JSON.stringify(DEFAULT_THRESHOLDS, null, 2), 'utf-8');
      return DEFAULT_THRESHOLDS;
    }

    const rawData = fs.readFileSync(THRESHOLDS_CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(rawData);
    if (parsed && typeof parsed === 'object') {
      const delaySec = Number(parsed.delaySec) || DEFAULT_THRESHOLDS.delaySec;
      const frozenSec = Number(parsed.frozenSec) || DEFAULT_THRESHOLDS.frozenSec;
      const deadSec = Number(parsed.deadSec) || DEFAULT_THRESHOLDS.deadSec;
      return { delaySec, frozenSec, deadSec };
    }
    return DEFAULT_THRESHOLDS;
  } catch (err) {
    console.error('Error reading heartbeat thresholds config:', err.message);
    return DEFAULT_THRESHOLDS;
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
  return sanitized;
}

/**
 * Reset heartbeat thresholds configuration to default
 */
function resetHeartbeatThresholdsConfig() {
  ensureDataDirExists();
  fs.writeFileSync(THRESHOLDS_CONFIG_FILE_PATH, JSON.stringify(DEFAULT_THRESHOLDS, null, 2), 'utf-8');
  return DEFAULT_THRESHOLDS;
}

module.exports = {
  getHeartbeatModulesConfig,
  saveHeartbeatModulesConfig,
  resetHeartbeatModulesConfig,
  getHeartbeatThresholdsConfig,
  saveHeartbeatThresholdsConfig,
  resetHeartbeatThresholdsConfig,
  DEFAULT_MODULES,
  DEFAULT_THRESHOLDS
};
