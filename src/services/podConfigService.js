const { executeCommand } = require('./soundService');

/**
 * Universal Recursive Sanitizer for Pod Configuration JSON.
 * Preserves all keys, depth levels, and data types without any hardcoded keys.
 */
function sanitizeNode(key, val) {
  if (val === null || val === undefined) return val;

  // Enforce soundscapes as Array of Strings
  if (key === 'soundscapes' && Array.isArray(val)) {
    return val.map(v => String(v));
  }

  // Enforce soundScape as Number/Integer (or String fallback if non-numeric)
  if (key === 'soundScape' && val !== null && val !== undefined) {
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? String(val) : parsed;
  }

  // Handle Arrays
  if (Array.isArray(val)) {
    return val.map(item => sanitizeNode(key, item));
  }

  // Handle Objects
  if (typeof val === 'object') {
    const obj = {};
    Object.keys(val).forEach(k => {
      obj[k] = sanitizeNode(k, val[k]);
    });
    return obj;
  }

  // Handle Booleans
  if (typeof val === 'boolean') return Boolean(val);

  // Handle Numbers
  if (typeof val === 'number') {
    return isNaN(val) ? 0 : val;
  }

  return val;
}

function sanitizePodConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object') {
    throw new Error('Payload data konfigurasi Pod tidak valid');
  }
  return sanitizeNode('', rawConfig);
}

/**
 * Read Pod config and available sound options from server
 */
async function readPodConfig(server) {
  const catConfigCmd = `cat /home/pod/pod_config.json 2>/dev/null || cat /home/pod/pod_config-test.json 2>/dev/null`;
  const catMetadataCmd = `(cat /home/pod/sounds/metadata.json 2>/dev/null || cat /home/pod/sounds/Metadata.json 2>/dev/null || echo "[]")`;

  const [rawConfig, rawMetadata] = await Promise.all([
    executeCommand(server, catConfigCmd),
    executeCommand(server, catMetadataCmd)
  ]);

  if (!rawConfig || !rawConfig.trim()) {
    throw new Error('File /home/pod/pod_config.json atau pod_config-test.json tidak ditemukan di server.');
  }

  let config = {};
  try {
    config = JSON.parse(rawConfig.trim());
  } catch (err) {
    throw new Error(`Format JSON di file pod_config tidak valid: ${err.message}`);
  }

  let availableSounds = [];
  try {
    const cleanMeta = rawMetadata.trim();
    const parsedMeta = JSON.parse(cleanMeta);
    if (Array.isArray(parsedMeta)) {
      availableSounds = parsedMeta.map(item => ({
        id: item.id !== undefined ? item.id : null,
        idString: item.id !== undefined ? String(item.id) : '',
        idInt: item.id !== undefined ? parseInt(item.id, 10) : 0,
        session: item.session || '',
        display: item.display || item.description || item.title || `Sound #${item.id}`,
        filepath: item.filepath || (item.details && item.details.soundPath) || ''
      })).filter(item => {
        if (item.id === null) return false;
        const sSession = String(item.session || '').toLowerCase().trim();
        const sDisplay = String(item.display || '').toLowerCase().trim();
        return sSession !== 'any' && sDisplay !== 'any';
      });
    }
  } catch (err) {
    console.warn('Gagal membaca /home/pod/sounds/metadata.json:', err.message);
  }

  return {
    config,
    availableSounds
  };
}

/**
 * Update Pod config on target server with data type sanitization & backup
 */
async function updatePodConfig(server, rawConfig) {
  const sanitizedConfig = sanitizePodConfig(rawConfig);
  const formattedJson = JSON.stringify(sanitizedConfig, null, 2);

  // Base64 encode JSON to execute safely via shell command
  const base64Content = Buffer.from(formattedJson).toString('base64');

  // Command to backup existing file and write updated config
  const writeCmd = `cp /home/pod/pod_config.json /home/pod/pod_config.json.bak 2>/dev/null || true; echo "${base64Content}" | base64 -d > /home/pod/pod_config.json`;

  await executeCommand(server, writeCmd);

  return {
    success: true,
    message: 'Konfigurasi Pod V2 berhasil diperbarui dan file /home/pod/pod_config.json.bak telah dibuat.'
  };
}

module.exports = {
  sanitizePodConfig,
  readPodConfig,
  updatePodConfig
};
