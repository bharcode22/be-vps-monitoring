const { exec } = require('child_process');
const { Client } = require('ssh2');
const path = require('path');
const { decrypt } = require('../utils/crypto');
const { executeSshCommand } = require('../utils/sshExecutor');
const { categorizeFile, formatBytes } = require('./s3Service');

/**
 * Execute command on local host or remote SSH server with configurable timeout
 */
function executeCommand(server, command, timeoutMs = 60000) {
  return executeSshCommand(server, command, { timeoutMs });
}

/**
 * Get comprehensive disk and media folder storage breakdown for a POD server
 */
async function getPodStorageSummary(server) {
  // Command to get disk partition usage (df) and individual folder sizes (du)
  const script = `
    # 1. Total Disk Volume for root partition
    df_out=$(df -B1 / 2>/dev/null | tail -n 1)
    
    # 2. Sizes of /home/pod directories
    vids_size=$(du -sb /home/pod/videos 2>/dev/null | awk '{print $1}' || echo "0")
    sounds_size=$(du -sb /home/pod/sounds 2>/dev/null | awk '{print $1}' || echo "0")
    images_size=$(du -sb /home/pod/images 2>/dev/null | awk '{print $1}' || echo "0")
    
    # 3. File counts
    vids_count=$(find /home/pod/videos -type f 2>/dev/null | wc -l || echo "0")
    sounds_count=$(find /home/pod/sounds -type f 2>/dev/null | wc -l || echo "0")
    images_count=$(find /home/pod/images -type f 2>/dev/null | wc -l || echo "0")

    echo "DISK:$df_out"
    echo "VIDEOS:$vids_size:$vids_count"
    echo "SOUNDS:$sounds_size:$sounds_count"
    echo "IMAGES:$images_size:$images_count"
  `;

  const output = await executeCommand(server, script);
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

  let diskTotal = 0;
  let diskUsed = 0;
  let diskFree = 0;
  let diskPercent = 0;

  let videosBytes = 0;
  let videosCount = 0;
  let soundsBytes = 0;
  let soundsCount = 0;
  let imagesBytes = 0;
  let imagesCount = 0;

  for (const line of lines) {
    if (line.startsWith('DISK:')) {
      const parts = line.replace('DISK:', '').trim().split(/\s+/);
      if (parts.length >= 4) {
        diskTotal = parseInt(parts[1], 10) || 0;
        diskUsed = parseInt(parts[2], 10) || 0;
        diskFree = parseInt(parts[3], 10) || 0;
        diskPercent = diskTotal > 0 ? Math.round((diskUsed / diskTotal) * 100) : 0;
      }
    } else if (line.startsWith('VIDEOS:')) {
      const parts = line.replace('VIDEOS:', '').split(':');
      videosBytes = parseInt(parts[0], 10) || 0;
      videosCount = parseInt(parts[1], 10) || 0;
    } else if (line.startsWith('SOUNDS:')) {
      const parts = line.replace('SOUNDS:', '').split(':');
      soundsBytes = parseInt(parts[0], 10) || 0;
      soundsCount = parseInt(parts[1], 10) || 0;
    } else if (line.startsWith('IMAGES:')) {
      const parts = line.replace('IMAGES:', '').split(':');
      imagesBytes = parseInt(parts[0], 10) || 0;
      imagesCount = parseInt(parts[1], 10) || 0;
    }
  }

  const totalMediaBytes = videosBytes + soundsBytes + imagesBytes;
  const totalMediaFiles = videosCount + soundsCount + imagesCount;

  return {
    serverId: server.id,
    serverName: server.name,
    code: server.code || '',
    host: server.host,
    port: server.port || 22,
    podVersion: server.pod_version || 'v3',
    status: 'online',
    disk: {
      totalBytes: diskTotal,
      usedBytes: diskUsed,
      freeBytes: diskFree,
      totalFormatted: formatBytes(diskTotal),
      usedFormatted: formatBytes(diskUsed),
      freeFormatted: formatBytes(diskFree),
      percentUsed: diskPercent,
      isHighUsage: diskPercent >= 85
    },
    folders: {
      videos: {
        path: '/home/pod/videos',
        bytes: videosBytes,
        formatted: formatBytes(videosBytes),
        count: videosCount
      },
      sounds: {
        path: '/home/pod/sounds',
        bytes: soundsBytes,
        formatted: formatBytes(soundsBytes),
        count: soundsCount
      },
      images: {
        path: '/home/pod/images',
        bytes: imagesBytes,
        formatted: formatBytes(imagesBytes),
        count: imagesCount
      }
    },
    totalMediaBytes,
    totalMediaFormatted: formatBytes(totalMediaBytes),
    totalMediaFiles
  };
}

/**
 * Scan all physical files in /home/pod/sounds, /home/pod/videos, /home/pod/images
 */
async function scanPodPhysicalFiles(server) {
  // High-performance batch scan using find -printf or stat -exec
  const scanCmd = `(find /home/pod/sounds /home/pod/videos /home/pod/images -type f -printf "%p|%s|%T@\\n" 2>/dev/null || find /home/pod/sounds /home/pod/videos /home/pod/images -type f -exec stat -c "%n|%s|%Y" {} + 2>/dev/null)`;

  const output = await executeCommand(server, scanCmd);
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

  const files = [];

  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 2) continue;

    const fullPath = parts[0];
    const sizeBytes = parseInt(parts[1], 10) || 0;
    const epochSec = parseFloat(parts[2]) || 0;
    const filename = path.basename(fullPath);
    const category = categorizeFile(filename);

    let folderType = 'other';
    if (fullPath.startsWith('/home/pod/videos')) folderType = 'videos';
    else if (fullPath.startsWith('/home/pod/sounds')) folderType = 'sounds';
    else if (fullPath.startsWith('/home/pod/images')) folderType = 'images';

    files.push({
      fullPath,
      filename,
      folderType,
      category,
      sizeBytes,
      sizeFormatted: formatBytes(sizeBytes),
      lastModified: epochSec > 0 ? new Date(epochSec * 1000).toISOString() : null
    });
  }

  return files;
}

/**
 * Detect orphan/junk files by comparing POD physical files against S3 Master files and metadata
 */
async function detectPodJunkFiles(server, s3MasterFilenames = [], metadataActiveFiles = []) {
  const physicalFiles = await scanPodPhysicalFiles(server);

  // Normalize set of valid filenames from S3 and metadata
  const validFilenames = new Set(s3MasterFilenames.map(f => path.basename(f).toLowerCase()));
  metadataActiveFiles.forEach(f => validFilenames.add(path.basename(f).toLowerCase()));

  // Whitelisted system / core files that must NEVER be flagged as junk
  const whitelist = new Set([
    'metadata.json',
    'metadata.json.bak',
    '.env',
    '.gitignore',
    'readme.md'
  ]);

  let totalJunkBytes = 0;
  const categorized = physicalFiles.map(file => {
    const fnLower = file.filename.toLowerCase();

    // If file is whitelisted
    if (whitelist.has(fnLower)) {
      return { ...file, isJunk: false, isProtected: true, status: 'protected' };
    }

    // If we have S3 master data to compare against
    if (validFilenames.size > 0) {
      const isMatched = validFilenames.has(fnLower);
      if (!isMatched) {
        totalJunkBytes += file.sizeBytes;
        return {
          ...file,
          isJunk: true,
          isProtected: false,
          status: 'orphan',
          reason: 'Tidak ditemukan di AWS S3 Master / Metadata aktif'
        };
      }
      return {
        ...file,
        isJunk: false,
        isProtected: false,
        status: 'active',
        reason: 'Sesuai dengan AWS S3 Master'
      };
    }

    // Default: if no S3 list provided yet, show as unverified
    return {
      ...file,
      isJunk: false,
      isProtected: false,
      status: 'unverified',
      reason: 'Belum diverifikasi dengan AWS S3'
    };
  });

  const junkFiles = categorized.filter(f => f.isJunk);
  const activeFiles = categorized.filter(f => !f.isJunk);

  return {
    serverId: server.id,
    serverName: server.name,
    totalFiles: categorized.length,
    totalSizeBytes: categorized.reduce((acc, f) => acc + f.sizeBytes, 0),
    totalSizeFormatted: formatBytes(categorized.reduce((acc, f) => acc + f.sizeBytes, 0)),
    junkFilesCount: junkFiles.length,
    junkTotalBytes: totalJunkBytes,
    junkTotalFormatted: formatBytes(totalJunkBytes),
    activeFilesCount: activeFiles.length,
    files: categorized
  };
}

/**
 * Safely delete junk files from POD with path validation and whitelisting
 */
async function cleanupPodJunkFiles(server, filePaths = [], isDryRun = true) {
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return {
      success: true,
      deletedCount: 0,
      freedBytes: 0,
      freedFormatted: '0 B',
      isDryRun,
      deletedFiles: []
    };
  }

  // Strictly validate each path to ensure it belongs to /home/pod/sounds, /home/pod/videos, or /home/pod/images
  const allowedPrefixes = ['/home/pod/sounds/', '/home/pod/videos/', '/home/pod/images/'];
  const safePaths = [];
  const rejectedPaths = [];

  for (const p of filePaths) {
    const cleanPath = path.normalize(p.trim());
    const isAllowed = allowedPrefixes.some(prefix => cleanPath.startsWith(prefix));
    const base = path.basename(cleanPath).toLowerCase();

    if (!isAllowed || base === 'metadata.json' || base === '.env') {
      rejectedPaths.push(cleanPath);
    } else {
      safePaths.push(cleanPath);
    }
  }

  if (safePaths.length === 0) {
    throw new Error('Tidak ada file valid yang memenuhi kriteria penghapusan aman di /home/pod/');
  }

  // Scan files to get sizes before deleting
  const physicalFiles = await scanPodPhysicalFiles(server);
  const fileMap = new Map(physicalFiles.map(f => [f.fullPath, f]));

  let totalBytesToFree = 0;
  const targetedFiles = [];

  safePaths.forEach(sp => {
    const info = fileMap.get(sp);
    const size = info ? info.sizeBytes : 0;
    totalBytesToFree += size;
    targetedFiles.push({
      path: sp,
      filename: path.basename(sp),
      sizeBytes: size,
      sizeFormatted: formatBytes(size)
    });
  });

  if (isDryRun) {
    return {
      success: true,
      isDryRun: true,
      message: `Pratinjau: ${safePaths.length} file akan dibebaskan (~${formatBytes(totalBytesToFree)})`,
      totalFiles: safePaths.length,
      freedBytes: totalBytesToFree,
      freedFormatted: formatBytes(totalBytesToFree),
      files: targetedFiles,
      rejectedPaths
    };
  }

  // Execute deletion in safe chunks (max 50 files per rm command)
  const chunkSize = 50;
  let deletedCount = 0;

  for (let i = 0; i < safePaths.length; i += chunkSize) {
    const chunk = safePaths.slice(i, i + chunkSize);
    const escapedPaths = chunk.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
    const rmCmd = `rm -f ${escapedPaths}`;
    await executeCommand(server, rmCmd);
    deletedCount += chunk.length;
  }

  return {
    success: true,
    isDryRun: false,
    deletedCount,
    freedBytes: totalBytesToFree,
    freedFormatted: formatBytes(totalBytesToFree),
    deletedFiles: targetedFiles,
    rejectedPaths
  };
}

/**
 * Check file presence for a specific S3 code on a single POD
 * Directly tests /home/pod/sounds/<file>, /home/pod/videos/<file>, /home/pod/images/<file>
 */
async function checkCodeFilesOnSinglePod(server, s3Code, filenames = []) {
  try {
    if (!filenames || filenames.length === 0) {
      return {
        serverId: server.id,
        serverName: server.name,
        code: server.code || '',
        host: server.host,
        status: 'online',
        fileStatus: 'none',
        foundCount: 0,
        totalExpected: 0,
        totalBytes: 0,
        totalFormatted: '0 B',
        files: [],
        missingFiles: []
      };
    }

    // Build high-performance test script with Base64 JSON payload to prevent escaping/quoting bugs
    const b64Json = Buffer.from(JSON.stringify(filenames)).toString('base64');

    const checkScript = `
python3 -c "
import json, os, base64, sys

try:
    filenames = json.loads(base64.b64decode('${b64Json}').decode('utf-8'))
except Exception as e:
    sys.exit(1)

for fn in filenames:
    p_sound = os.path.join('/home/pod/sounds', fn)
    p_video = os.path.join('/home/pod/videos', fn)
    p_image = os.path.join('/home/pod/images', fn)
    
    if os.path.isfile(p_sound):
        print(f'EXISTS|{p_sound}|{fn}|{os.path.getsize(p_sound)}|sounds')
    elif os.path.isfile(p_video):
        print(f'EXISTS|{p_video}|{fn}|{os.path.getsize(p_video)}|videos')
    elif os.path.isfile(p_image):
        print(f'EXISTS|{p_image}|{fn}|{os.path.getsize(p_image)}|images')
    else:
        found = None
        for base in ['/home/pod/sounds', '/home/pod/videos', '/home/pod/images']:
            if not os.path.isdir(base): continue
            for root, dirs, files in os.walk(base):
                for f in files:
                    if f.lower() == fn.lower():
                        found = (os.path.join(root, f), os.path.getsize(os.path.join(root, f)), os.path.basename(base))
                        break
                if found: break
            if found: break
        if found:
            print(f'EXISTS|{found[0]}|{fn}|{found[1]}|{found[2]}')
        else:
            print(f'MISSING||{fn}|0|none')
" 2>/dev/null
    `;

    const output = await executeCommand(server, checkScript);
    const lines = output.split('\n').map(l => l.trim()).filter(Boolean);

    const foundFiles = [];
    const missingFiles = [];
    let totalBytes = 0;

    for (const line of lines) {
      const parts = line.split('|');
      if (parts.length < 4) continue;

      const statusTag = parts[0];
      const fullPath = parts[1];
      const filename = parts[2];
      const sizeBytes = parseInt(parts[3], 10) || 0;
      const folder = parts[4] || 'other';

      if (statusTag === 'EXISTS' && fullPath) {
        totalBytes += sizeBytes;
        foundFiles.push({
          fullPath,
          filename,
          folderType: folder,
          category: categorizeFile(filename),
          sizeBytes,
          sizeFormatted: formatBytes(sizeBytes)
        });
      } else {
        missingFiles.push({
          filename,
          category: categorizeFile(filename)
        });
      }
    }

    const totalExpected = filenames.length;
    const foundCount = foundFiles.length;

    let fileStatus = 'none'; // 'all' | 'partial' | 'none'
    if (foundCount > 0) {
      if (foundCount >= totalExpected) {
        fileStatus = 'all';
      } else {
        fileStatus = 'partial';
      }
    }

    return {
      serverId: server.id,
      serverName: server.name,
      code: server.code || '',
      host: server.host,
      status: 'online',
      fileStatus,
      foundCount,
      totalExpected,
      totalBytes,
      totalFormatted: formatBytes(totalBytes),
      files: foundFiles,
      missingFiles
    };
  } catch (err) {
    return {
      serverId: server.id,
      serverName: server.name,
      code: server.code || '',
      host: server.host,
      status: 'offline',
      fileStatus: 'error',
      foundCount: 0,
      totalExpected: filenames?.length || 0,
      totalBytes: 0,
      totalFormatted: '0 B',
      files: [],
      missingFiles: filenames || [],
      error: err.message || 'SSH error'
    };
  }
}

/**
 * Hard delete files matching a specific S3 code from a POD server
 */
async function hardDeletePodCodeFiles(server, s3Code, filenames = []) {
  const checkRes = await checkCodeFilesOnSinglePod(server, s3Code, filenames);
  if (checkRes.status === 'offline') {
    throw new Error(`Server ${server.name} (${server.host}) sedang offline atau tidak dapat diakses SSH.`);
  }

  const pathsToDelete = checkRes.files.map(f => f.fullPath);
  if (pathsToDelete.length === 0) {
    return {
      serverId: server.id,
      serverName: server.name,
      deletedCount: 0,
      freedBytes: 0,
      freedFormatted: '0 B',
      message: `Tidak ada file untuk kode #${s3Code} di server ${server.name}`
    };
  }

  const cleanupRes = await cleanupPodJunkFiles(server, pathsToDelete, false);
  return {
    serverId: server.id,
    serverName: server.name,
    deletedCount: cleanupRes.deletedCount,
    freedBytes: cleanupRes.freedBytes,
    freedFormatted: cleanupRes.freedFormatted,
    deletedFiles: cleanupRes.deletedFiles
  };
}

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
  const isAllowed = normalized.startsWith('/home/pod/sounds') ||
                    normalized.startsWith('/home/pod/videos') ||
                    normalized.startsWith('/home/pod/images');

  if (!isAllowed) {
    res.status(403).json({ error: 'Akses path direktori tidak diizinkan. Hanya /home/pod/ yang dapat diakses.' });
    return;
  }

  const conn = new Client();
  let isClosed = false;

  const safeEnd = () => {
    if (!isClosed) {
      isClosed = true;
      try { conn.end(); } catch (_) {}
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

          const chunkSize = (end - start) + 1;
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

/**
 * Inspect Docker disk usage (BuildKit cache, dangling images, container logs, volumes) on a POD server
 */
async function inspectPodDockerStorage(server) {
  try {
    const pythonScript = `
import subprocess, json, os

def run(cmd):
    try:
        return subprocess.check_output(cmd, shell=True, stderr=subprocess.DEVNULL, timeout=25).decode('utf-8', 'ignore').strip()
    except Exception:
        return ''

# 1. Disk root volume /
df_out = run('df -B1 / | tail -n 1')
disk_total = 0
disk_used = 0
disk_free = 0
percent_used = 0
if df_out:
    parts = df_out.split()
    if len(parts) >= 5:
        try:
            disk_total = int(parts[1])
            disk_used = int(parts[2])
            disk_free = int(parts[3])
            percent_used = int(parts[4].replace('%', ''))
        except:
            pass

# 2. Docker system df
df_docker = run("docker system df --format '{{json .}}'")
images = {'total': 0, 'active': 0, 'size': '0 B', 'reclaimable': '0 B'}
containers = {'total': 0, 'active': 0, 'size': '0 B', 'reclaimable': '0 B'}
volumes = {'total': 0, 'active': 0, 'size': '0 B', 'reclaimable': '0 B'}
build_cache = {'count': 0, 'size': '0 B', 'reclaimable': '0 B'}

if df_docker:
    for line in df_docker.splitlines():
        line = line.strip()
        if not line: continue
        try:
            obj = json.loads(line)
            t = obj.get('Type', '')
            if t == 'Images':
                images['total'] = int(obj.get('TotalCount', 0))
                images['active'] = int(obj.get('Active', 0))
                images['size'] = obj.get('Size', '0B')
                images['reclaimable'] = obj.get('Reclaimable', '0B')
            elif t == 'Containers':
                containers['total'] = int(obj.get('TotalCount', 0))
                containers['active'] = int(obj.get('Active', 0))
                containers['size'] = obj.get('Size', '0B')
                containers['reclaimable'] = obj.get('Reclaimable', '0B')
            elif t == 'Local Volumes':
                volumes['total'] = int(obj.get('TotalCount', 0))
                volumes['active'] = int(obj.get('Active', 0))
                volumes['size'] = obj.get('Size', '0B')
                volumes['reclaimable'] = obj.get('Reclaimable', '0B')
            elif t == 'Build Cache':
                build_cache['count'] = int(obj.get('TotalCount', 0))
                build_cache['size'] = obj.get('Size', '0B')
                build_cache['reclaimable'] = obj.get('Reclaimable', '0B')
        except:
            pass

# 3. Docker logs size in /var/lib/docker/containers/*/*.log
logs_out = run('du -cb /var/lib/docker/containers/*/*.log 2>/dev/null | tail -n 1')
logs_bytes = 0
if logs_out:
    try:
        logs_bytes = int(logs_out.split()[0])
    except:
        logs_bytes = 0

# 4. Dangling images count
dangling_out = run('docker images -f "dangling=true" -q | wc -l')
dangling_count = 0
try:
    dangling_count = int(dangling_out)
except:
    pass

# 5. Media Folders size and count (/home/pod/videos, /sounds, /images)
folders = {}
for name, folder_path in [('videos', '/home/pod/videos'), ('sounds', '/home/pod/sounds'), ('images', '/home/pod/images')]:
    f_count = 0
    f_bytes = 0
    if os.path.exists(folder_path):
        try:
            for root, dirs, files in os.walk(folder_path):
                for f in files:
                    fp = os.path.join(root, f)
                    try:
                        f_bytes += os.path.getsize(fp)
                        f_count += 1
                    except:
                        pass
        except:
            pass
    folders[name] = {'count': f_count, 'bytes': f_bytes}

res = {
    'disk': {
        'totalBytes': disk_total,
        'usedBytes': disk_used,
        'freeBytes': disk_free,
        'percentUsed': percent_used
    },
    'docker': {
        'images': images,
        'danglingImagesCount': dangling_count,
        'containers': containers,
        'volumes': volumes,
        'buildCache': build_cache,
        'logsBytes': logs_bytes
    },
    'folders': folders
}
print(json.dumps(res))
`;

    const b64Code = Buffer.from(pythonScript).toString('base64');
    const stdout = await executeCommand(server, `python3 -c "$(echo '${b64Code}' | base64 -d)"`);
    
    let parsed = null;
    try {
      parsed = JSON.parse(stdout.trim());
    } catch (e) {
      throw new Error(`Output tidak valid dari server: ${stdout.slice(0, 100)}`);
    }

    const disk = parsed.disk || {};
    const docker = parsed.docker || {};
    const foldersRaw = parsed.folders || {};

    const folders = {
      videos: {
        count: foldersRaw.videos?.count || 0,
        bytes: foldersRaw.videos?.bytes || 0,
        formatted: formatBytes(foldersRaw.videos?.bytes || 0)
      },
      sounds: {
        count: foldersRaw.sounds?.count || 0,
        bytes: foldersRaw.sounds?.bytes || 0,
        formatted: formatBytes(foldersRaw.sounds?.bytes || 0)
      },
      images: {
        count: foldersRaw.images?.count || 0,
        bytes: foldersRaw.images?.bytes || 0,
        formatted: formatBytes(foldersRaw.images?.bytes || 0)
      }
    };

    const totalMediaBytes = folders.videos.bytes + folders.sounds.bytes + folders.images.bytes;

    return {
      serverId: server.id,
      serverName: server.name,
      code: server.code || '',
      host: server.host,
      status: 'online',
      disk: {
        totalBytes: disk.totalBytes || 0,
        usedBytes: disk.usedBytes || 0,
        freeBytes: disk.freeBytes || 0,
        percentUsed: disk.percentUsed || 0,
        totalFormatted: formatBytes(disk.totalBytes || 0),
        usedFormatted: formatBytes(disk.usedBytes || 0),
        freeFormatted: formatBytes(disk.freeBytes || 0)
      },
      docker: {
        images: docker.images || {},
        danglingImagesCount: docker.danglingImagesCount || 0,
        containers: docker.containers || {},
        volumes: docker.volumes || {},
        buildCache: docker.buildCache || {},
        logsBytes: docker.logsBytes || 0,
        logsFormatted: formatBytes(docker.logsBytes || 0)
      },
      folders,
      totalMediaBytes,
      totalMediaFormatted: formatBytes(totalMediaBytes)
    };

  } catch (err) {
    return {
      serverId: server.id,
      serverName: server.name,
      code: server.code || '',
      host: server.host,
      status: 'offline',
      error: err.message,
      disk: { percentUsed: 0, totalFormatted: '0 B', usedFormatted: '0 B', freeFormatted: '0 B' },
      docker: {
        images: { total: 0, active: 0, size: '0 B', reclaimable: '0 B' },
        danglingImagesCount: 0,
        containers: { total: 0, active: 0, size: '0 B', reclaimable: '0 B' },
        volumes: { total: 0, active: 0, size: '0 B', reclaimable: '0 B' },
        buildCache: { count: 0, size: '0 B', reclaimable: '0 B' },
        logsBytes: 0,
        logsFormatted: '0 B'
      }
    };
  }
}

/**
 * Execute Docker cleanup on a single POD server
 * cleanType: 'safe' | 'deep' | 'logs' | 'all'
 */
async function cleanPodDockerStorage(server, cleanType = 'safe') {
  // Quick pre-check disk usage via df -B1 / (fast ~0.5s instead of full heavy inspection)
  let usedBefore = 0;
  try {
    const beforeDf = await executeCommand(server, 'df -B1 / | tail -n 1', 15000);
    if (beforeDf) {
      const parts = beforeDf.trim().split(/\s+/);
      if (parts.length >= 3) {
        usedBefore = parseInt(parts[2], 10) || 0;
      }
    }
  } catch (err) {
    throw new Error(`Server ${server.name} (${server.host}) sedang offline atau tidak dapat diakses SSH: ${err.message}`);
  }

  let cmd = '';
  if (cleanType === 'safe') {
    cmd = `
      docker builder prune -f 2>&1 || true;
      docker image prune -f 2>&1 || true;
      docker container prune -f 2>&1 || true;
    `;
  } else if (cleanType === 'deep') {
    cmd = `
      docker builder prune -a -f 2>&1 || true;
      docker image prune -a -f 2>&1 || true;
      docker container prune -f 2>&1 || true;
    `;
  } else if (cleanType === 'logs') {
    cmd = `
      find /var/lib/docker/containers/ -name "*.log" -exec truncate -s 0 {} + 2>/dev/null || true;
    `;
  } else if (cleanType === 'all') {
    cmd = `
      docker builder prune -a -f 2>&1 || true;
      docker image prune -a -f 2>&1 || true;
      docker container prune -f 2>&1 || true;
      find /var/lib/docker/containers/ -name "*.log" -exec truncate -s 0 {} + 2>/dev/null || true;
    `;
  }

  // Allow up to 180 seconds (3 minutes) for Docker to delete GBs of layers & build cache
  const rawOutput = await executeCommand(server, cmd, 180000);

  // Inspect after cleanup to calculate freed space and return fresh stats
  const afterInspection = await inspectPodDockerStorage(server);
  const usedAfter = afterInspection.disk?.usedBytes || 0;
  const freedBytes = Math.max(0, usedBefore - usedAfter);

  return {
    serverId: server.id,
    serverName: server.name,
    code: server.code || '',
    cleanType,
    freedBytes,
    freedFormatted: formatBytes(freedBytes),
    output: rawOutput.trim().slice(-1000),
    disk: afterInspection.disk,
    docker: afterInspection.docker
  };
}

module.exports = {
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
  cleanPodDockerStorage
};

