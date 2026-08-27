const path = require('path');
const { executeCommand } = require('./podDiskService');
const { categorizeFile, formatBytes } = require('../s3Service');

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
 * Categorize rogue files on a POD against a set of valid filenames
 */
async function detectPodRogueFiles(server, validFilenamesSet) {
  const physicalFiles = await scanPodPhysicalFiles(server);

  const whitelist = new Set([
    'metadata.json',
    'metadata.json.bak',
    '.env',
    '.gitignore',
    'readme.md'
  ]);

  let totalRogueBytes = 0;
  const categorized = physicalFiles.map(file => {
    const fnLower = file.filename.toLowerCase();

    if (whitelist.has(fnLower)) {
      return { ...file, isRogue: false, isProtected: true, status: 'protected' };
    }

    if (validFilenamesSet.size > 0) {
      const isMatched = validFilenamesSet.has(fnLower);
      if (!isMatched) {
        totalRogueBytes += file.sizeBytes;
        return {
          ...file,
          isRogue: true,
          isProtected: false,
          status: 'rogue',
          reason: 'Tidak terdaftar di AWS S3 maupun tabel multimedia Master'
        };
      }
      return {
        ...file,
        isRogue: false,
        isProtected: false,
        status: 'active',
        reason: 'Terdaftar sebagai media valid'
      };
    }

    return {
      ...file,
      isRogue: false,
      isProtected: false,
      status: 'unverified',
      reason: 'Belum diverifikasi'
    };
  });

  const rogueFiles = categorized.filter(f => f.isRogue);
  const activeFiles = categorized.filter(f => !f.isRogue);

  return {
    serverId: server.id,
    serverName: server.name,
    totalFiles: categorized.length,
    totalSizeBytes: categorized.reduce((acc, f) => acc + f.sizeBytes, 0),
    totalSizeFormatted: formatBytes(categorized.reduce((acc, f) => acc + f.sizeBytes, 0)),
    rogueFilesCount: rogueFiles.length,
    rogueTotalBytes: totalRogueBytes,
    rogueTotalFormatted: formatBytes(totalRogueBytes),
    activeFilesCount: activeFiles.length,
    files: categorized
  };
}

/**
 * Download master S3 media files to a specific POD server into appropriate directories
 * (/home/pod/sounds, /home/pod/videos, /home/pod/images)
 */
async function downloadS3FilesToPod(server, s3Code, filenames = [], onProgress = null) {
  if (!server) throw new Error('Server POD tidak ditemukan.');
  if (!s3Code) throw new Error('Kode folder S3 wajib diisi.');
  if (!filenames || !Array.isArray(filenames) || filenames.length === 0) {
    throw new Error('Daftar file yang akan didownload tidak boleh kosong.');
  }

  const baseUrl = (process.env.AWS_URL || 'https://developerfile-084897310273.s3.ap-southeast-1.amazonaws.com').replace(/\/+$/, '');
  const cleanCode = String(s3Code).trim().replace(/^\/+/, '').replace(/^media\/?/i, '').replace(/^\/+|\/+$/g, '');

  // Prepare file items with designated target folder
  const items = filenames.map(fn => {
    const filename = String(fn).trim();
    const category = categorizeFile(filename);
    let folderType = 'sounds';
    if (category === 'video') folderType = 'videos';
    else if (category === 'image') folderType = 'images';
    else if (category === 'audio' || category === 'strobe') folderType = 'sounds';
    else folderType = 'sounds';

    return {
      filename,
      folderType,
      category
    };
  });

  const payload = {
    baseUrl,
    s3Code: cleanCode,
    files: items
  };

  const b64Payload = Buffer.from(JSON.stringify(payload)).toString('base64');

  // Script using Python3 to download files safely with urllib reporthook for live progress
  const downloadScript = `
python3 -c "
import json, os, sys, base64, urllib.request, urllib.parse, time

try:
    data = json.loads(base64.b64decode('${b64Payload}').decode('utf-8'))
except Exception as e:
    sys.exit(1)

base_url = data['baseUrl']
s3_code = data['s3Code']
files = data['files']

results = []
for item in files:
    fn = item['filename']
    folder = item['folderType']
    dest_dir = os.path.join('/home/pod', folder)
    try:
        os.makedirs(dest_dir, exist_ok=True)
    except Exception as e:
        results.append({'filename': fn, 'status': 'error', 'folderType': folder, 'error': f'Gagal membuat direktori: {e}'})
        continue

    dest_path = os.path.join(dest_dir, fn)
    encoded_fn = urllib.parse.quote(fn)
    encoded_code = urllib.parse.quote(s3_code)
    url = f'{base_url}/media/{encoded_code}/{encoded_fn}'

    last_t = [time.time()]
    last_b = [0]

    def make_reporthook(filename):
        def reporthook(block_num, block_size, total_size):
            now = time.time()
            downloaded = block_num * block_size
            if total_size > 0 and downloaded > total_size:
                downloaded = total_size
            dt = now - last_t[0]
            if dt >= 0.25 or (total_size > 0 and downloaded >= total_size):
                speed_bps = (downloaded - last_b[0]) / dt if dt > 0 else 0
                speed_mb = speed_bps / (1024 * 1024)
                speed_str = f'{speed_mb:.1f} MB/s' if speed_mb >= 1 else f'{speed_bps / 1024:.0f} KB/s'
                percent = int((downloaded / total_size) * 100) if total_size > 0 else 0
                prog = {
                    'filename': filename,
                    'downloaded': downloaded,
                    'total': total_size,
                    'percent': percent,
                    'speed': speed_str
                }
                print(f'PROGRESS|{json.dumps(prog)}', flush=True)
                last_t[0] = now
                last_b[0] = downloaded
        return reporthook

    try:
        urllib.request.urlretrieve(url, dest_path, reporthook=make_reporthook(fn))
        size = os.path.getsize(dest_path)
        results.append({
            'filename': fn,
            'status': 'success',
            'folderType': folder,
            'destPath': dest_path,
            'sizeBytes': size
        })
    except Exception as e:
        results.append({
            'filename': fn,
            'status': 'error',
            'folderType': folder,
            'error': str(e)
        })

print('DOWNLOAD_RESULT_JSON:' + json.dumps(results), flush=True)
"
`;

  let stdoutBuffer = '';
  const onStdout = (chunk) => {
    if (!onProgress) return;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // keep last incomplete line in buffer
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('PROGRESS|')) {
        try {
          const parsed = JSON.parse(trimmed.substring(9));
          onProgress({
            filename: parsed.filename,
            downloadedBytes: parsed.downloaded,
            totalBytes: parsed.total,
            downloadedFormatted: formatBytes(parsed.downloaded),
            totalFormatted: formatBytes(parsed.total),
            percent: parsed.percent,
            speed: parsed.speed,
            status: 'downloading'
          });
        } catch (_) {}
      }
    }
  };

  const output = await executeCommand(server, downloadScript, 300000, { onStdout }); // 5 minutes timeout
  const match = output.match(/DOWNLOAD_RESULT_JSON:(.*)/);

  if (!match) {
    throw new Error(`Gagal mengeksekusi download di POD: ${output.substring(0, 200)}`);
  }

  let downloadedResults = [];
  try {
    downloadedResults = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Format respon download di POD tidak valid: ${err.message}`);
  }

  const successList = downloadedResults.filter(r => r.status === 'success');
  const errorList = downloadedResults.filter(r => r.status === 'error');
  const totalDownloadedBytes = successList.reduce((acc, f) => acc + (f.sizeBytes || 0), 0);

  return {
    serverId: server.id,
    serverName: server.name,
    s3Code: cleanCode,
    totalRequested: filenames.length,
    successCount: successList.length,
    errorCount: errorList.length,
    totalDownloadedBytes,
    totalDownloadedFormatted: formatBytes(totalDownloadedBytes),
    downloads: downloadedResults
  };
}

module.exports = {
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  detectPodRogueFiles,
  downloadS3FilesToPod
};
