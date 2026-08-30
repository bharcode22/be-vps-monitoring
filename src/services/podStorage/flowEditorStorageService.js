const { S3Client, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { executeCommand } = require('./podDiskService');
const { formatBytes } = require('../s3Service');
const { decrypt } = require('../../utils/crypto');

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

const S3_BUCKET = process.env.AWS_S3_BUCKET;
const S3_REGION = process.env.AWS_REGION;
const S3_BASE_URL = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/images/`;

/**
 * 1. Fetch S3 object map under images/ prefix and match with fileFlowEditor records
 */
async function getFlowEditorS3Files(dbFiles = []) {
  // Retrieve all objects in S3 under images/ prefix
  let token = undefined;
  const s3Map = new Map();

  try {
    do {
      const cmd = new ListObjectsV2Command({
        Bucket: S3_BUCKET,
        Prefix: 'images/',
        ContinuationToken: token
      });
      const res = await s3Client.send(cmd);
      if (res.Contents) {
        for (const item of res.Contents) {
          const fn = item.Key.replace(/^images\//, '').trim();
          if (fn) {
            s3Map.set(fn.toLowerCase(), {
              key: item.Key,
              sizeBytes: item.Size,
              sizeFormatted: formatBytes(item.Size),
              lastModified: item.LastModified
            });
          }
        }
      }
      token = res.NextContinuationToken;
    } while (token);
  } catch (err) {
    console.error('Gagal mengambil daftar file S3 images/:', err.message);
  }

  // Merge dbFiles with S3 metadata
  return dbFiles.map(row => {
    const fn = (row.file_name || '').trim();
    const fnLower = fn.toLowerCase();
    const ft = (row.file_type || '').toLowerCase();
    const isVideo = ft.includes('video') || fnLower.endsWith('.mp4') || fnLower.endsWith('.mkv') || fnLower.endsWith('.webm');
    const folderType = isVideo ? 'videos' : 'images';
    const targetPath = `/home/pod/${folderType}/${fn}`;

    const s3Meta = s3Map.get(fnLower);
    const existsInS3 = !!s3Meta;

    return {
      id: row.id,
      filename: fn,
      fileType: row.file_type || (isVideo ? 'video/mp4' : 'image/png'),
      category: isVideo ? 'video' : 'image',
      placement: row.placement || 'general',
      folderType,
      targetPath,
      url: row.url || `${S3_BASE_URL}${encodeURIComponent(fn)}`,
      s3Key: s3Meta?.key || `images/${fn}`,
      existsInS3,
      sizeBytes: s3Meta?.sizeBytes || 0,
      sizeFormatted: s3Meta?.sizeFormatted || '0 B',
      s3LastModified: s3Meta?.lastModified || null,
      createdDate: row.created_date,
      updateDate: row.update_date
    };
  });
}

/**
 * 2. Cross-check Flow Editor files on a single remote POD server
 */
async function checkFlowFilesOnSinglePod(server, flowFiles = []) {
  if (!server) throw new Error('Server POD tidak ditemukan.');

  const b64Data = Buffer.from(JSON.stringify(flowFiles.map(f => ({
    id: f.id,
    filename: f.filename,
    folderType: f.folderType,
    sizeBytes: f.sizeBytes,
    sizeFormatted: f.sizeFormatted
  })))).toString('base64');

  const checkScript = `
python3 -c "
import os, sys, json, base64

files_data = json.loads(base64.b64decode('${b64Data}').decode('utf-8'))

images_dir = '/home/pod/images'
videos_dir = '/home/pod/videos'

def get_dir_files(d):
    res = {}
    if os.path.exists(d):
        for name in os.listdir(d):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                try:
                    res[name.lower()] = {
                        'realName': name,
                        'fullPath': p,
                        'size': os.path.getsize(p),
                        'mtime': os.path.getmtime(p)
                    }
                except Exception:
                    pass
    return res

img_files = get_dir_files(images_dir)
vid_files = get_dir_files(videos_dir)

found = []
missing = []
total_found_bytes = 0

for item in files_data:
    fn = item['filename']
    fn_lower = fn.lower()
    folder_type = item.get('folderType', 'images')
    target_dict = vid_files if folder_type == 'videos' else img_files
    target_dir = videos_dir if folder_type == 'videos' else images_dir
    target_path = os.path.join(target_dir, fn)

    if fn_lower in target_dict:
        meta = target_dict[fn_lower]
        total_found_bytes += meta['size']
        found.append({
            'id': item.get('id'),
            'filename': fn,
            'folderType': folder_type,
            'fullPath': meta['fullPath'],
            'sizeBytes': meta['size'],
            'mtime': meta['mtime']
        })
    else:
        missing.append({
            'id': item.get('id'),
            'filename': fn,
            'folderType': folder_type,
            'targetPath': target_path,
            'expectedBytes': item.get('sizeBytes', 0),
            'expectedFormatted': item.get('sizeFormatted', '0 B')
        })

out = {
    'found': found,
    'missing': missing,
    'totalFoundBytes': total_found_bytes
}
print('POD_FLOW_CHECK:' + json.dumps(out))
"
  `;

  const output = await executeCommand(server, checkScript, 20000);
  const match = output.match(/POD_FLOW_CHECK:(.*)/);
  if (!match) {
    throw new Error(`Gagal memproses hasil pemeriksaan flow files di POD: ${output.substring(0, 150)}`);
  }

  let parsed = { found: [], missing: [], totalFoundBytes: 0 };
  try {
    parsed = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`Format respon POD tidak valid: ${err.message}`);
  }

  const foundFiles = parsed.found.map(f => ({
    ...f,
    sizeFormatted: formatBytes(f.sizeBytes)
  }));

  const missingFiles = parsed.missing;
  const totalCount = flowFiles.length;
  const foundCount = foundFiles.length;
  const missingCount = missingFiles.length;

  let fileStatus = 'none';
  if (foundCount === totalCount && totalCount > 0) fileStatus = 'all';
  else if (foundCount > 0) fileStatus = 'partial';

  return {
    serverId: server.id,
    serverName: server.name,
    host: server.host,
    totalCount,
    foundCount,
    missingCount,
    fileStatus,
    totalBytes: parsed.totalFoundBytes,
    totalFormatted: formatBytes(parsed.totalFoundBytes),
    foundFiles,
    missingFiles
  };
}

/**
 * 3. Cross-check Flow Editor files across all active POD servers in parallel
 */
async function checkFlowFilesOnAllPods(servers = [], flowFiles = []) {
  const results = {};
  await Promise.all(
    servers.map(async (server) => {
      try {
        const podCheck = await checkFlowFilesOnSinglePod(server, flowFiles);
        results[server.id] = podCheck;
      } catch (err) {
        console.error(`Error checking flow files on ${server.name}:`, err.message);
        results[server.id] = {
          serverId: server.id,
          serverName: server.name,
          host: server.host,
          error: err.message,
          totalCount: flowFiles.length,
          foundCount: 0,
          missingCount: flowFiles.length,
          fileStatus: 'error',
          totalBytes: 0,
          totalFormatted: '0 B',
          foundFiles: [],
          missingFiles: flowFiles
        };
      }
    })
  );
  return results;
}

/**
 * 4. Download requested Flow Editor files from S3 to remote POD server
 */
async function downloadFlowFilesToPod(server, filenames = [], onProgress) {
  if (!server) throw new Error('Server POD tidak ditemukan.');
  if (!Array.isArray(filenames) || filenames.length === 0) {
    throw new Error('Daftar file yang akan didownload tidak boleh kosong.');
  }

  // Pre-download folder permission verification & auto-repair
  let sudoPass = '';
  try {
    if (server.password) sudoPass = decrypt(server.password);
  } catch (_) { }

  const repairScript = sudoPass ? `
    echo "${sudoPass}" | sudo -S mkdir -p /home/pod/images /home/pod/videos 2>/dev/null
    echo "${sudoPass}" | sudo -S chown -R pod:pod /home/pod/images /home/pod/videos 2>/dev/null
    echo "${sudoPass}" | sudo -S chmod 777 /home/pod/images /home/pod/videos 2>/dev/null
  ` : `
    mkdir -p /home/pod/images /home/pod/videos 2>/dev/null
    chmod 777 /home/pod/images /home/pod/videos 2>/dev/null
  `;
  try {
    await executeCommand(server, repairScript, 10000);
  } catch (permErr) {
    console.warn(`[FlowDownload] Pre-download folder permission repair notice for ${server.name}: ${permErr.message}`);
  }

  const b64Filenames = Buffer.from(JSON.stringify(filenames)).toString('base64');
  const downloadScript = `
python3 -c "
import os, sys, json, base64, urllib.request, subprocess, time

bucket = '${S3_BUCKET}'
region = '${S3_REGION}'
filenames = json.loads(base64.b64decode('${b64Filenames}').decode('utf-8'))

os.makedirs('/home/pod/images', exist_ok=True)
os.makedirs('/home/pod/videos', exist_ok=True)

results = []

def format_speed(bps):
    if bps >= 1024 * 1024:
        return f'{bps / (1024 * 1024):.1f} MB/s'
    elif bps >= 1024:
        return f'{bps / 1024:.1f} KB/s'
    return f'{bps:.0f} B/s'

for fn in filenames:
    fn_lower = fn.lower()
    is_video = fn_lower.endswith('.mp4') or fn_lower.endswith('.mkv') or fn_lower.endswith('.webm')
    folder_type = 'videos' if is_video else 'images'
    dest_path = f'/home/pod/{folder_type}/{fn}'
    encoded_fn = urllib.parse.quote(fn)
    s3_url = f'https://{bucket}.s3.{region}.amazonaws.com/images/{encoded_fn}'

    max_retries = 3
    file_success = False
    last_err = ''

    for attempt in range(1, max_retries + 1):
        try:
            req = urllib.request.Request(s3_url, headers={
                'User-Agent': 'Mozilla/5.0 (POD-Sync-Agent/1.0)',
                'Connection': 'close'
            })
            start_time = time.time()
            last_progress_time = start_time
            last_downloaded = 0

            with urllib.request.urlopen(req, timeout=45) as response, open(dest_path, 'wb') as out_file:
                total_length = response.getheader('content-length')
                total_bytes = int(total_length) if total_length else 0
                downloaded = 0
                chunk_size = 128 * 1024

                while True:
                    chunk = response.read(chunk_size)
                    if not chunk:
                        break
                    out_file.write(chunk)
                    downloaded += len(chunk)
                    now = time.time()

                    if now - last_progress_time >= 0.25 or downloaded == total_bytes:
                        elapsed = now - last_progress_time
                        bytes_diff = downloaded - last_downloaded
                        speed_str = format_speed(bytes_diff / elapsed if elapsed > 0 else 0)
                        pct = int((downloaded / total_bytes) * 100) if total_bytes > 0 else 0

                        prog_payload = {
                            'filename': fn,
                            'downloaded': downloaded,
                            'total': total_bytes,
                            'percent': pct,
                            'speed': speed_str
                        }
                        print('PROGRESS|' + json.dumps(prog_payload), flush=True)

                        last_progress_time = now
                        last_downloaded = downloaded

            if os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
                file_success = True
                break
        except Exception as e:
            last_err = str(e)
            if os.path.exists(dest_path):
                try: os.remove(dest_path)
                except Exception: pass
            if attempt < max_retries:
                time.sleep(1.5 * attempt)

    # Fallback to curl with built-in retry if urllib encountered connection reset
    if not file_success:
        try:
            curl_cmd = [
                'curl', '-sSL',
                '--retry', '3',
                '--retry-delay', '2',
                '--connect-timeout', '15',
                '-m', '300',
                s3_url,
                '-o', dest_path
            ]
            cp = subprocess.run(curl_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=315)
            if cp.returncode == 0 and os.path.exists(dest_path) and os.path.getsize(dest_path) > 0:
                file_success = True
                # Send 100% progress
                sz = os.path.getsize(dest_path)
                print('PROGRESS|' + json.dumps({
                    'filename': fn,
                    'downloaded': sz,
                    'total': sz,
                    'percent': 100,
                    'speed': 'OK'
                }), flush=True)
            else:
                last_err += f' | curl fallback: {cp.stderr.strip()}'
        except Exception as ce:
            last_err += f' | curl error: {ce}'

    if file_success:
        results.append({
            'filename': fn,
            'status': 'success',
            'folderType': folder_type,
            'destPath': dest_path,
            'sizeBytes': os.path.getsize(dest_path)
        })
    else:
        results.append({
            'filename': fn,
            'status': 'error',
            'folderType': folder_type,
            'destPath': dest_path,
            'error': last_err or 'Gagal mendownload file setelah 3x percobaan'
        })

print('DOWNLOAD_RESULT_JSON:' + json.dumps(results))
"
  `;

  let stdoutBuffer = '';
  const onStdout = (chunk) => {
    if (!onProgress) return;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
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
        } catch (_) { }
      }
    }
  };

  const output = await executeCommand(server, downloadScript, 300000, { onStdout, resetTimeoutOnActivity: true });
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
    totalRequested: filenames.length,
    successCount: successList.length,
    errorCount: errorList.length,
    totalDownloadedBytes,
    totalDownloadedFormatted: formatBytes(totalDownloadedBytes),
    downloads: downloadedResults
  };
}

/**
 * 5. Delete physical Flow Editor file on a specific POD server
 */
async function deleteFlowFileFromPod(server, filename, folderType = 'images') {
  if (!server) throw new Error('Server POD tidak ditemukan.');
  if (!filename) throw new Error('Nama file wajib ditentukan.');

  const folder = folderType === 'videos' ? 'videos' : 'images';
  const targetPath = `/home/pod/${folder}/${filename}`;
  const safeFilename = filename.replace(/'/g, "'\\''");

  const deleteScript = `
    if [ -f '/home/pod/${folder}/${safeFilename}' ]; then
      rm -f '/home/pod/${folder}/${safeFilename}'
      echo "DELETED:OK"
    else
      echo "DELETED:NOT_FOUND"
    fi
  `;

  const output = await executeCommand(server, deleteScript, 10000);
  const isDeleted = output.includes('DELETED:OK');

  return {
    serverId: server.id,
    serverName: server.name,
    filename,
    folderType: folder,
    targetPath,
    deleted: isDeleted
  };
}

/**
 * 6. Delete file from AWS S3 images/ prefix
 */
async function deleteFlowFileFromS3(filename) {
  if (!filename) throw new Error('Nama file wajib ditentukan.');
  const key = `images/${filename}`;

  const cmd = new DeleteObjectCommand({
    Bucket: S3_BUCKET,
    Key: key
  });

  await s3Client.send(cmd);
  return {
    key,
    filename,
    deleted: true,
    message: `File ${filename} berhasil dihapus dari S3 prefix images/`
  };
}

module.exports = {
  getFlowEditorS3Files,
  checkFlowFilesOnSinglePod,
  checkFlowFilesOnAllPods,
  downloadFlowFilesToPod,
  deleteFlowFileFromPod,
  deleteFlowFileFromS3
};
