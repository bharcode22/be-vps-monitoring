const path = require('path');
const fs = require('fs');
const fsPromises = require('fs').promises;
const https = require('https');
const http = require('http');
const { URL } = require('url');
const FormData = require('form-data');

const MASTER_API_BASE = process.env.MASTER_API_BASE;
const MASTER_USERNAME = process.env.MASTER_API_USERNAME;
const MASTER_PASSWORD = process.env.MASTER_API_PASSWORD;

// Temporary directory for receiving chunks
const TEMP_UPLOAD_BASE = path.join(__dirname, '../../tmp/uploads');

// Ensure base upload directory exists
if (!fs.existsSync(TEMP_UPLOAD_BASE)) {
  fs.mkdirSync(TEMP_UPLOAD_BASE, { recursive: true });
}

// Token cache in memory
let cachedToken = null;
let tokenExpiresAt = 0;

function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

function formatDuration(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '0s';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Obtain JWT token from Master API (with auto-caching)
 */
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const loginUrl = `${MASTER_API_BASE}/auth/login`;
  console.log(`🔑 Mengautentikasi ke Master API (${loginUrl})...`);

  try {
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernameOrEmail: MASTER_USERNAME,
        password: MASTER_PASSWORD
      })
    });

    const data = await res.json();
    if (!res.ok || !data?.token) {
      throw new Error(data?.message || data?.error || `Gagal login ke Master API (HTTP ${res.status})`);
    }

    cachedToken = data.token;
    // Set expiry to 23 hours from now (standard JWT 24h)
    tokenExpiresAt = now + 23 * 60 * 60 * 1000;
    console.log('✅ Berhasil mendapatkan JWT Token dari Master API');
    return cachedToken;
  } catch (err) {
    console.error('❌ Error authenticating to Master API:', err.message);
    throw err;
  }
}

/**
 * Save an incoming binary chunk stream directly to disk
 */
async function saveChunkStream(uploadSessionId, fieldName, chunkIndex, totalChunks, originalFilename, reqStream) {
  if (!uploadSessionId || !fieldName || chunkIndex === undefined) {
    throw new Error('Parameter chunk upload tidak lengkap');
  }

  const safeSessionId = String(uploadSessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const safeFieldName = String(fieldName).replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkDir = path.join(TEMP_UPLOAD_BASE, safeSessionId, safeFieldName);

  await fsPromises.mkdir(chunkDir, { recursive: true });

  const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
  const writeStream = fs.createWriteStream(chunkPath);

  return new Promise((resolve, reject) => {
    reqStream.pipe(writeStream);

    writeStream.on('finish', () => {
      resolve({
        success: true,
        chunkIndex,
        totalChunks,
        fieldName: safeFieldName,
        sessionId: safeSessionId
      });
    });

    writeStream.on('error', (err) => {
      console.error(`Error writing chunk ${chunkIndex} for ${safeFieldName}:`, err.message);
      reject(err);
    });

    reqStream.on('error', (err) => {
      console.error(`Error in reqStream chunk ${chunkIndex}:`, err.message);
      writeStream.destroy();
      reject(err);
    });
  });
}

/**
 * Sequentially merge chunks for a specific field into one complete file
 */
async function mergeFieldChunks(sessionDir, fieldName, totalChunks, finalFilename, onChunkMerged) {
  const safeFieldName = String(fieldName).replace(/[^a-zA-Z0-9_-]/g, '');
  const chunkDir = path.join(sessionDir, safeFieldName);
  const safeFilename = path.basename(finalFilename || `${safeFieldName}.bin`);
  const assembledFilePath = path.join(sessionDir, `assembled_${safeFieldName}_${safeFilename}`);

  // If only 1 chunk exists, rename it
  if (totalChunks === 1) {
    const singleChunkPath = path.join(chunkDir, 'chunk_0');
    if (!fs.existsSync(singleChunkPath)) {
      throw new Error(`Chunk 0 untuk ${safeFieldName} tidak ditemukan di ${singleChunkPath}`);
    }
    await fsPromises.rename(singleChunkPath, assembledFilePath);
    if (onChunkMerged) onChunkMerged(1, 1);
    return assembledFilePath;
  }

  const writeStream = fs.createWriteStream(assembledFilePath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(chunkDir, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      writeStream.destroy();
      throw new Error(`Chunk ke-${i} dari total ${totalChunks} untuk ${safeFieldName} tidak ditemukan`);
    }

    await new Promise((resolve, reject) => {
      const readStream = fs.createReadStream(chunkPath);
      readStream.pipe(writeStream, { end: false });
      readStream.on('end', () => {
        resolve();
      });
      readStream.on('error', (err) => {
        reject(err);
      });
    });

    if (onChunkMerged) {
      onChunkMerged(i + 1, totalChunks);
    }

    // Delete chunk after appending to save disk space immediately
    try {
      await fsPromises.unlink(chunkPath);
    } catch (_) { }
  }

  // End write stream
  await new Promise((resolve) => writeStream.end(resolve));

  return assembledFilePath;
}

/**
 * Stream FormData directly to Master API with real-time progress callbacks
 */
function sendFormDataToMasterApiWithProgress(targetUrl, formData, token, onProgress) {
  return new Promise((resolve, reject) => {
    formData.getLength((err, totalLength) => {
      if (err) return reject(err);

      const parsedUrl = new URL(targetUrl);
      const isHttps = parsedUrl.protocol === 'https:';
      const client = isHttps ? https : http;

      const headers = {
        ...formData.getHeaders(),
        'Authorization': token,
        'Content-Length': totalLength
      };

      const options = {
        method: 'POST',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        headers
      };

      const req = client.request(options, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => {
          responseBody += chunk;
        });
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(responseBody);
          } catch (_) { }

          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json || { message: 'Upload multimedia berhasil' });
          } else {
            const errorMsg = json?.message || json?.error || responseBody || `HTTP ${res.statusCode}`;
            reject(new Error(errorMsg));
          }
        });
      });

      req.on('error', (err) => {
        reject(err);
      });

      let bytesSent = 0;
      const startTime = Date.now();
      let lastEmitTime = 0;

      formData.on('data', (chunk) => {
        bytesSent += chunk.length;
        const now = Date.now();
        if (now - lastEmitTime > 200 || bytesSent === totalLength) {
          lastEmitTime = now;
          const elapsedSec = (now - startTime) / 1000;
          const speedBytesSec = elapsedSec > 0 ? bytesSent / elapsedSec : 0;
          const remainingBytes = totalLength - bytesSent;
          const remainingSec = speedBytesSec > 0 ? Math.ceil(remainingBytes / speedBytesSec) : 0;

          if (onProgress) {
            onProgress({
              bytesSent,
              totalBytes: totalLength,
              progress: Math.min(100, Math.round((bytesSent / totalLength) * 100)),
              speedFormatted: `${formatBytes(speedBytesSec)}/s`,
              etaFormatted: formatDuration(remainingSec),
              bytesSentFormatted: formatBytes(bytesSent),
              totalBytesFormatted: formatBytes(totalLength)
            });
          }
        }
      });

      formData.pipe(req);
    });
  });
}

/**
 * Assemble all uploaded chunks, perform auth, and dispatch FormData to Master API with real-time Socket.IO emission
 */
async function dispatchToMasterApi(uploadSessionId, metadata, filesManifest, io = null) {
  const safeSessionId = String(uploadSessionId).replace(/[^a-zA-Z0-9_-]/g, '');
  const sessionDir = path.join(TEMP_UPLOAD_BASE, safeSessionId);

  if (!fs.existsSync(sessionDir)) {
    throw new Error(`Sesi upload ${safeSessionId} tidak ditemukan atau sudah kadaluarsa`);
  }

  const emitProgress = (payload) => {
    if (io) {
      io.emit('multimedia_backend_progress', {
        uploadSessionId: safeSessionId,
        ...payload
      });
    }
  };

  try {
    // STAGE 1: Merging Chunks on Disk
    emitProgress({
      stage: 'merging',
      stageTitle: 'Menggabungkan Chunks di Server',
      progress: 5,
      message: 'Server sedang menggabungkan potongan file...'
    });

    const formData = new FormData();
    const manifestEntries = Object.entries(filesManifest);
    let mergedFileCount = 0;

    for (const [fieldName, fileInfo] of manifestEntries) {
      if (!fileInfo || !fileInfo.filename || fileInfo.totalChunks === undefined) {
        continue;
      }

      console.log(`📦 Menggabungkan chunk untuk [${fieldName}] (${fileInfo.filename}, total: ${fileInfo.totalChunks} chunks)...`);

      const assembledPath = await mergeFieldChunks(
        sessionDir,
        fieldName,
        fileInfo.totalChunks,
        fileInfo.filename,
        (currentChunk, totalChunks) => {
          emitProgress({
            stage: 'merging',
            stageTitle: 'Menggabungkan Chunks di Server',
            progress: Math.round(((mergedFileCount + (currentChunk / totalChunks)) / manifestEntries.length) * 100),
            currentFile: fieldName,
            message: `Menggabungkan [${fieldName.toUpperCase()}]: chunk ${currentChunk}/${totalChunks}...`
          });
        }
      );

      mergedFileCount++;

      // Attach file read stream with original filename
      formData.append(fieldName, fs.createReadStream(assembledPath), {
        filename: fileInfo.filename
      });
      console.log(`✅ File [${fieldName}] siap dikirim ke Master API`);
    }

    // Append metadata
    formData.append('tittle', metadata.tittle || '');
    formData.append('artist', metadata.artist || '');
    formData.append('album', metadata.album || '');
    formData.append('file', metadata.file || '');
    formData.append('IsShowAtCustom', metadata.IsShowAtCustom || 'show');

    // STAGE 2: Auth
    emitProgress({
      stage: 'auth',
      stageTitle: 'Autentikasi Master API',
      progress: 100,
      message: 'Mengautentikasi JWT token ke Master API...'
    });

    const token = await getAuthToken();

    // STAGE 3: Dispatching / Uploading from Backend to Master API & AWS S3
    const uploadUrl = `${MASTER_API_BASE}/multimedia`;
    console.log(`🚀 Mengirim form-data multimedia lengkap ke ${uploadUrl}...`);

    emitProgress({
      stage: 'dispatching',
      stageTitle: 'Mengunggah ke Master API & S3',
      progress: 0,
      message: 'Memulai pengiriman payload data dari server monitoring ke Master API...'
    });

    const result = await sendFormDataToMasterApiWithProgress(
      uploadUrl,
      formData,
      token,
      (progressData) => {
        emitProgress({
          stage: 'dispatching',
          stageTitle: 'Mengunggah ke Master API & S3',
          progress: progressData.progress,
          bytesSentFormatted: progressData.bytesSentFormatted,
          totalBytesFormatted: progressData.totalBytesFormatted,
          speedFormatted: progressData.speedFormatted,
          etaFormatted: progressData.etaFormatted,
          message: `Mengunggah dari Server ke Master API (${progressData.bytesSentFormatted} / ${progressData.totalBytesFormatted} - ${progressData.progress}%)`
        });
      }
    );

    // STAGE 4: Final Processing
    emitProgress({
      stage: 'processing',
      stageTitle: 'Finalisasi Master DB & S3',
      progress: 100,
      message: 'Master API selesai memproses. Menyelaraskan katalog S3...'
    });

    console.log('🎉 Sukses mengunggah multimedia ke Master API!');

    // STAGE 5: Completed
    emitProgress({
      stage: 'completed',
      stageTitle: 'Selesai!',
      progress: 100,
      message: 'Multimedia berhasil diunggah dan terdaftar di Master AWS S3 & Database.'
    });

    return {
      success: true,
      data: result
    };
  } catch (err) {
    console.error('❌ Error during dispatchToMasterApi:', err.message);
    emitProgress({
      stage: 'error',
      stageTitle: 'Gagal',
      progress: 0,
      message: err.message || 'Gagal mengirim data ke Master API'
    });
    throw err;
  } finally {
    // Clean up temporary session directory and assembled files
    await cleanupSession(safeSessionId);
  }
}

/**
 * Clean up temporary upload session directory
 */
async function cleanupSession(uploadSessionId) {
  try {
    const safeSessionId = String(uploadSessionId).replace(/[^a-zA-Z0-9_-]/g, '');
    const sessionDir = path.join(TEMP_UPLOAD_BASE, safeSessionId);
    if (fs.existsSync(sessionDir)) {
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
      console.log(`🧹 Direktori sesi upload ${safeSessionId} berhasil dibersihkan`);
    }
  } catch (err) {
    console.warn(`Gagal membersihkan direktori sesi ${uploadSessionId}:`, err.message);
  }
}

module.exports = {
  getAuthToken,
  saveChunkStream,
  mergeFieldChunks,
  dispatchToMasterApi,
  cleanupSession
};
