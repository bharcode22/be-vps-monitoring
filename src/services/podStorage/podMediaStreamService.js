const { Client } = require('ssh2');
const path = require('path');
const { decrypt } = require('../../utils/crypto');

/**
 * Helper to determine Mime-Type for audio, video, image files
 */
function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.flac': 'audio/flac',
    '.aac': 'audio/aac',
    '.m4a': 'audio/mp4',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.json': 'application/json',
    '.txt': 'text/plain'
  };
  return map[ext] || 'application/octet-stream';
}

/**
 * Stream a media file directly from remote POD via SFTP with HTTP 206 Range support
 */
async function streamPodPhysicalFile(server, filePath, req, res) {
  const normalized = path.normalize(filePath);
  const isAllowed =
    normalized.startsWith('/home/pod/sounds') ||
    normalized.startsWith('/home/pod/videos') ||
    normalized.startsWith('/home/pod/images');

  if (!isAllowed) {
    res
      .status(403)
      .json({ error: 'Akses path direktori tidak diizinkan. Hanya /home/pod/ yang dapat diakses.' });
    return;
  }

  const conn = new Client();
  let isClosed = false;

  const safeEnd = () => {
    if (!isClosed) {
      isClosed = true;
      try {
        conn.end();
      } catch (_) {}
    }
  };

  res.on('close', safeEnd);
  res.on('error', safeEnd);

  conn.on('ready', () => {
    conn.sftp((err, sftp) => {
      if (err) {
        safeEnd();
        if (!res.headersSent) {
          res.status(500).json({ error: `Gagal membuka sesi SFTP: ${err.message}` });
        }
        return;
      }

      sftp.stat(normalized, (statErr, stats) => {
        if (statErr || !stats) {
          safeEnd();
          if (!res.headersSent) {
            res.status(404).json({ error: 'File tidak ditemukan di server POD' });
          }
          return;
        }

        const totalSize = stats.size;
        const mimeType = getMimeType(normalized);
        const range = req.headers.range;

        if (range) {
          // Parse Range Header: "bytes=start-end"
          const parts = range.replace(/bytes=/, '').split('-');
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : totalSize - 1;

          if (start >= totalSize || end >= totalSize || start > end) {
            safeEnd();
            res.writeHead(416, {
              'Content-Range': `bytes */${totalSize}`
            });
            return res.end();
          }

          const chunkSize = end - start + 1;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': mimeType,
            'Cache-Control': 'public, max-age=3600'
          });

          const readStream = sftp.createReadStream(normalized, { start, end });
          readStream.on('error', (streamErr) => {
            console.error('SFTP range stream error:', streamErr.message);
            safeEnd();
          });
          readStream.on('close', safeEnd);
          readStream.pipe(res);
        } else {
          // Full file stream (200 OK)
          res.writeHead(200, {
            'Content-Length': totalSize,
            'Content-Type': mimeType,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'public, max-age=3600'
          });

          const readStream = sftp.createReadStream(normalized);
          readStream.on('error', (streamErr) => {
            console.error('SFTP stream error:', streamErr.message);
            safeEnd();
          });
          readStream.on('close', safeEnd);
          readStream.pipe(res);
        }
      });
    });
  });

  conn.on('error', (connErr) => {
    safeEnd();
    if (!res.headersSent) {
      res.status(500).json({ error: `Koneksi SSH ke POD gagal: ${connErr.message}` });
    }
  });

  const sshConfig = {
    host: server.host,
    port: server.port || 22,
    username: server.username || 'pod',
    readyTimeout: 15000
  };

  if (server.auth_type === 'key' && server.private_key) {
    sshConfig.privateKey = decrypt(server.private_key);
  } else {
    sshConfig.password = decrypt(server.password);
  }

  conn.connect(sshConfig);
}

module.exports = {
  getMimeType,
  streamPodPhysicalFile
};
