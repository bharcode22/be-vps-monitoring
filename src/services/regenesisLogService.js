const path = require('path');
const fs = require('fs');
const { Client } = require('ssh2');
const { executeSshCommand } = require('../utils/sshExecutor');
const { decrypt } = require('../utils/crypto');

const LOG_DIR = '/home/pod/Documents/RegenesisLogs';

/**
 * Format bytes into human readable format (KB, MB, GB)
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * Categorize log file based on its naming convention
 */
function categorizeLogFile(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('app-big')) {
    return { category: 'App Big', color: 'purple', prefix: 'app-big' };
  }
  if (lower.includes('app-small')) {
    return { category: 'App Small', color: 'cyan', prefix: 'app-small' };
  }
  if (lower.includes('cursor')) {
    return { category: 'Cursor Log', color: 'amber', prefix: 'cursor' };
  }
  if (lower.includes('touchpad')) {
    return { category: 'Touchpad', color: 'emerald', prefix: 'touchpad' };
  }
  if (lower.includes('uxplay')) {
    return { category: 'UxPlay', color: 'indigo', prefix: 'uxplay' };
  }
  return { category: 'General Log', color: 'slate', prefix: 'other' };
}

/**
 * Extract date from filename if available (e.g. 2026-08-27 or 26-07-18)
 */
function extractLogDate(filename) {
  // Matches 2026-08-27 or similar
  const fullDateMatch = filename.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (fullDateMatch) return fullDateMatch[1];

  // Matches short date like 26-07-18
  const shortDateMatch = filename.match(/\b(\d{2}-\d{2}-\d{2})\b/);
  if (shortDateMatch) return `20${shortDateMatch[1]}`;

  return null;
}

/**
 * List all log files in /home/pod/Documents/RegenesisLogs on target POD
 */
async function listRegenesisLogs(server) {
  const cmd = `
    mkdir -p "${LOG_DIR}" 2>/dev/null;
    if command -v find >/dev/null 2>&1 && find "${LOG_DIR}" -maxdepth 1 -type f -printf "" 2>/dev/null; then
      find "${LOG_DIR}" -maxdepth 1 -type f -printf "%f|%s|%T@\\n" 2>/dev/null
    else
      for f in "${LOG_DIR}"/*; do
        if [ -f "$f" ]; then
          stat -c "%n|%s|%Y" "$f" 2>/dev/null || ls -l "$f" 2>/dev/null
        fi
      done
    fi
  `;

  const output = await executeSshCommand(server, cmd, { timeoutMs: 15000 });
  const lines = output.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  const files = [];

  for (const line of lines) {
    let filename = '';
    let sizeBytes = 0;
    let modifiedSec = 0;

    if (line.includes('|')) {
      const parts = line.split('|');
      filename = path.basename(parts[0]);
      sizeBytes = parseInt(parts[1], 10) || 0;
      modifiedSec = parseFloat(parts[2]) || 0;
    } else {
      // Fallback parse ls -l line
      const tokens = line.split(/\s+/);
      if (tokens.length >= 9) {
        filename = path.basename(tokens.slice(8).join(' '));
        sizeBytes = parseInt(tokens[4], 10) || 0;
      }
    }

    if (!filename || filename === '*' || filename.startsWith('.')) continue;

    const { category, color, prefix } = categorizeLogFile(filename);
    const dateLabel = extractLogDate(filename);
    const modifiedDate = modifiedSec > 0 ? new Date(modifiedSec * 1000).toISOString() : new Date().toISOString();

    files.push({
      filename,
      fullPath: `${LOG_DIR}/${filename}`,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      category,
      color,
      prefix,
      logDate: dateLabel,
      lastModified: modifiedDate
    });
  }

  // Sort newest first: by logDate if available, then by lastModified
  files.sort((a, b) => {
    if (a.logDate && b.logDate && a.logDate !== b.logDate) {
      return b.logDate.localeCompare(a.logDate);
    }
    return new Date(b.lastModified).getTime() - new Date(a.lastModified).getTime();
  });

  return {
    totalFiles: files.length,
    directory: LOG_DIR,
    files
  };
}

/**
 * Read contents of a specific log file in /home/pod/Documents/RegenesisLogs
 */
async function readRegenesisLog(server, rawFilename, options = {}) {
  const safeName = path.basename(rawFilename);
  if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
    throw new Error('Nama file tidak valid.');
  }

  const targetPath = `${LOG_DIR}/${safeName}`;
  const lines = parseInt(options.lines, 10) || 500;
  const search = options.search ? String(options.search).replace(/["$`\\]/g, '') : '';
  const isTail = options.direction !== 'head';

  let readCmd = '';
  if (search) {
    readCmd = `grep -i -E "${search}" "${targetPath}" 2>/dev/null | ${isTail ? `tail -n ${lines}` : `head -n ${lines}`}`;
  } else if (lines >= 50000 || options.lines === 'all') {
    readCmd = `cat "${targetPath}" 2>/dev/null`;
  } else {
    readCmd = isTail ? `tail -n ${lines} "${targetPath}" 2>/dev/null` : `head -n ${lines} "${targetPath}" 2>/dev/null`;
  }

  const metaCmd = `wc -l "${targetPath}" 2>/dev/null | awk '{print $1}'; stat -c "%s|%Y" "${targetPath}" 2>/dev/null || echo "0|0"`;

  const [content, metaOutput] = await Promise.all([
    executeSshCommand(server, readCmd, { timeoutMs: 25000 }),
    executeSshCommand(server, metaCmd, { timeoutMs: 10000 })
  ]);

  const metaLines = metaOutput.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const totalLines = parseInt(metaLines[0], 10) || 0;
  let sizeBytes = 0;
  let modifiedSec = 0;

  if (metaLines[1] && metaLines[1].includes('|')) {
    const parts = metaLines[1].split('|');
    sizeBytes = parseInt(parts[0], 10) || 0;
    modifiedSec = parseFloat(parts[1]) || 0;
  }

  const { category, color } = categorizeLogFile(safeName);

  return {
    filename: safeName,
    fullPath: targetPath,
    category,
    color,
    content: content || '(File log kosong atau tidak ada baris yang cocok)',
    totalLines,
    retrievedLines: content ? content.split('\n').length : 0,
    sizeBytes,
    sizeFormatted: formatBytes(sizeBytes),
    lastModified: modifiedSec > 0 ? new Date(modifiedSec * 1000).toISOString() : null
  };
}

/**
 * Stream download of a log file directly to client response
 */
async function streamDownloadRegenesisLog(server, rawFilename, req, res) {
  const safeName = path.basename(rawFilename);
  if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
    res.status(400).json({ success: false, error: 'Nama file log tidak valid' });
    return;
  }

  const targetPath = `${LOG_DIR}/${safeName}`;

  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');

  // 1. Local execution
  if (server.is_local === 1) {
    if (!fs.existsSync(targetPath)) {
      return res.status(404).json({ success: false, error: `File ${safeName} tidak ditemukan di server` });
    }
    const readStream = fs.createReadStream(targetPath);
    readStream.pipe(res);
    return;
  }

  // 2. Remote SSH execution
  const conn = new Client();
  let isClosed = false;

  const safeEnd = () => {
    if (!isClosed) {
      isClosed = true;
      try { conn.end(); } catch (_) { }
    }
  };

  res.on('close', safeEnd);
  res.on('error', safeEnd);

  let privateKey = null;
  let password = null;

  try {
    if (server.auth_type === 'key' && server.private_key) {
      privateKey = decrypt(server.private_key);
    } else if (server.password) {
      password = decrypt(server.password);
    }
  } catch (err) {
    safeEnd();
    return res.status(500).json({ success: false, error: `Gagal mendekripsi kredensial SSH: ${err.message}` });
  }

  conn.on('ready', () => {
    conn.exec(`cat "${targetPath}"`, (err, stream) => {
      if (err) {
        safeEnd();
        if (!res.headersSent) {
          return res.status(500).json({ success: false, error: `Gagal membaca file via SSH: ${err.message}` });
        }
        return;
      }

      stream.on('close', () => {
        safeEnd();
      });

      stream.stderr.on('data', (data) => {
        console.warn(`[streamDownload] stderr for ${safeName}:`, data.toString());
      });

      stream.pipe(res);
    });
  });

  conn.on('error', (err) => {
    safeEnd();
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: `Koneksi SSH gagal: ${err.message}` });
    }
  });

  conn.connect({
    host: server.host,
    port: server.port || 22,
    username: server.username || 'root',
    password: password || undefined,
    privateKey: privateKey || undefined,
    readyTimeout: 10000
  });
}

/**
 * Delete a specific log file from /home/pod/Documents/RegenesisLogs
 */
async function deleteRegenesisLog(server, rawFilename) {
  const safeName = path.basename(rawFilename);
  if (!safeName || safeName.includes('/') || safeName.includes('\\')) {
    throw new Error('Nama file tidak valid.');
  }

  const targetPath = `${LOG_DIR}/${safeName}`;
  const cmd = `rm -f "${targetPath}" && echo "DELETED_OK"`;

  const output = await executeSshCommand(server, cmd, { timeoutMs: 10000 });
  if (!output.includes('DELETED_OK')) {
    throw new Error('Gagal menghapus file log di server.');
  }

  return { success: true, filename: safeName };
}

module.exports = {
  LOG_DIR,
  listRegenesisLogs,
  readRegenesisLog,
  streamDownloadRegenesisLog,
  deleteRegenesisLog
};
