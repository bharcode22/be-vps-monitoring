const fs = require('fs');
const path = require('path');

const BACKEND_ENV_DIR = path.join(__dirname, '../../../envoirment');

/**
 * Parse raw .env file string into structured key-value array and object
 */
function parseEnvContent(rawContent = '') {
  const lines = rawContent.split(/\r?\n/);
  const items = [];
  const kvMap = {};

  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) {
      items.push({ type: 'empty', raw: line, lineNumber: index + 1 });
      return;
    }

    if (trimmed.startsWith('#')) {
      items.push({ type: 'comment', value: trimmed.replace(/^#\s*/, ''), raw: line, lineNumber: index + 1 });
      return;
    }

    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (match) {
      const key = match[1];
      let value = match[2] || '';

      // Strip surrounding quotes if present
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.substring(1, value.length - 1);
      }

      items.push({
        type: 'variable',
        key,
        value,
        raw: line,
        lineNumber: index + 1
      });
      kvMap[key] = value;
    } else {
      items.push({ type: 'raw', raw: line, lineNumber: index + 1 });
    }
  });

  return { items, kvMap };
}

/**
 * Serialize structured key-value items or object back into .env string
 */
function serializeEnvKv(kvList = []) {
  return kvList
    .map(item => {
      if (item.type === 'comment') return `# ${item.value}`;
      if (item.type === 'empty') return '';
      if (item.key) {
        const val = item.value || '';
        // If value contains spaces, special chars, or quotes, wrap in quotes
        if (val.includes(' ') || val.includes('#') || val.includes('$') || val.includes('"') || val.includes("'")) {
          return `${item.key}="${val.replace(/"/g, '\\"')}"`;
        }
        return `${item.key}=${val}`;
      }
      return item.raw || '';
    })
    .join('\n');
}

/**
 * Fetch list of available .env configuration files in backend/envoirment
 */
async function getEnvFiles() {
  try {
    if (!fs.existsSync(BACKEND_ENV_DIR)) {
      return { success: true, files: [] };
    }
    const fileNames = fs.readdirSync(BACKEND_ENV_DIR).filter(f => f.endsWith('.env') || f.endsWith('.env.example') || f.includes('.env'));
    const files = fileNames.map(fileName => {
      const filePath = path.join(BACKEND_ENV_DIR, fileName);
      let content = '';
      let stats = null;
      try {
        content = fs.readFileSync(filePath, 'utf8');
        stats = fs.statSync(filePath);
      } catch (e) {
        content = '';
      }
      const { items, kvMap } = parseEnvContent(content);

      return {
        name: fileName,
        path: filePath,
        source: 'backend',
        size: stats ? stats.size : 0,
        updatedAt: stats ? stats.mtime : null,
        variableCount: Object.keys(kvMap).length,
        lineCount: content.split(/\r?\n/).length,
        content,
        parsedItems: items,
        kvMap
      };
    });

    return { success: true, files };
  } catch (err) {
    console.error('Error reading env files directory:', err);
    return { success: false, error: err.message, files: [] };
  }
}

/**
 * Read specific .env file content by filename
 */
function readEnvFileContent(envFilename) {
  if (!envFilename) return '';

  const safeFilename = path.basename(envFilename);
  const envPath = path.join(BACKEND_ENV_DIR, safeFilename);
  if (fs.existsSync(envPath)) {
    try {
      return fs.readFileSync(envPath, 'utf8');
    } catch (e) {
      return '';
    }
  }
  return '';
}

/**
 * Create a new .env file in backend/envoirment
 */
async function createEnvFile(filename, content = '') {
  try {
    if (!filename) throw new Error('Nama file .env wajib diisi');

    const cleanFilename = path.basename(filename);
    if (!cleanFilename.endsWith('.env') && !cleanFilename.endsWith('.env.example')) {
      throw new Error('Nama file harus berakhiran .env atau .env.example');
    }

    if (!fs.existsSync(BACKEND_ENV_DIR)) {
      fs.mkdirSync(BACKEND_ENV_DIR, { recursive: true });
    }

    const targetPath = path.join(BACKEND_ENV_DIR, cleanFilename);
    if (fs.existsSync(targetPath)) {
      throw new Error(`File ${cleanFilename} sudah ada di direktori backend/envoirment`);
    }

    fs.writeFileSync(targetPath, content, 'utf8');
    return {
      success: true,
      message: `File ${cleanFilename} berhasil dibuat`,
      filename: cleanFilename
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Save / Update an existing .env file
 */
async function saveEnvFile(filename, content) {
  try {
    if (!filename) throw new Error('Nama file .env wajib diisi');
    if (content === undefined || content === null) throw new Error('Konten file .env wajib diisi');

    const cleanFilename = path.basename(filename);
    const targetPath = path.join(BACKEND_ENV_DIR, cleanFilename);

    fs.writeFileSync(targetPath, content, 'utf8');
    return {
      success: true,
      message: `File ${cleanFilename} berhasil disimpan`,
      filename: cleanFilename
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Delete a .env file from backend/envoirment
 */
async function deleteEnvFile(filename) {
  try {
    if (!filename) throw new Error('Nama file .env wajib diisi');

    const cleanFilename = path.basename(filename);
    const targetPath = path.join(BACKEND_ENV_DIR, cleanFilename);

    if (!fs.existsSync(targetPath)) {
      throw new Error(`File ${cleanFilename} tidak ditemukan`);
    }

    fs.unlinkSync(targetPath);
    return {
      success: true,
      message: `File ${cleanFilename} berhasil dihapus`,
      filename: cleanFilename
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Compare two .env files side by side and calculate diff matrix
 */
async function compareEnvFiles(sourceFileA, sourceFileB) {
  try {
    const contentA = readEnvFileContent(sourceFileA);
    const contentB = readEnvFileContent(sourceFileB);

    const { kvMap: kvA } = parseEnvContent(contentA);
    const { kvMap: kvB } = parseEnvContent(contentB);

    const allKeys = Array.from(new Set([...Object.keys(kvA), ...Object.keys(kvB)])).sort();

    let identicalCount = 0;
    let mismatchCount = 0;
    let onlyACount = 0;
    let onlyBCount = 0;

    const diffMatrix = allKeys.map(key => {
      const inA = Object.prototype.hasOwnProperty.call(kvA, key);
      const inB = Object.prototype.hasOwnProperty.call(kvB, key);
      const valA = inA ? kvA[key] : null;
      const valB = inB ? kvB[key] : null;

      let status = 'identical';
      if (inA && inB) {
        if (valA === valB) {
          status = 'identical';
          identicalCount++;
        } else {
          status = 'mismatch';
          mismatchCount++;
        }
      } else if (inA && !inB) {
        status = 'only_a';
        onlyACount++;
      } else if (!inA && inB) {
        status = 'only_b';
        onlyBCount++;
      }

      return {
        key,
        inA,
        inB,
        valA,
        valB,
        status
      };
    });

    return {
      success: true,
      sourceA: sourceFileA,
      sourceB: sourceFileB,
      stats: {
        totalKeys: allKeys.length,
        identicalCount,
        mismatchCount,
        onlyACount,
        onlyBCount
      },
      diffMatrix
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  getEnvFiles,
  readEnvFileContent,
  parseEnvContent,
  serializeEnvKv,
  createEnvFile,
  saveEnvFile,
  deleteEnvFile,
  compareEnvFiles
};
