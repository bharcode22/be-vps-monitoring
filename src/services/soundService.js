const { exec } = require('child_process');
const { Client } = require('ssh2');
const path = require('path');

/**
 * Execute command on local host or remote SSH server
 */
function executeCommand(server, command) {
  return new Promise((resolve, reject) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 35000 }, (error, stdout, stderr) => {
        if (error && !stdout) {
          return reject(new Error(stderr.trim() || error.message));
        }
        resolve(stdout || '');
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          reject(new Error('Koneksi SSH ke server waktu habis saat memproses data sounds (timeout 35 detik)'));
        }
      }, 35000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'root',
        readyTimeout: 10000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return reject(err);
          }

          let stdout = '';
          let stderr = '';

          stream.on('close', (code, signal) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve(stdout || '');
            }
          }).on('data', (data) => {
            stdout += data.toString();
          }).stderr.on('data', (data) => {
            stderr += data.toString();
          });
        });
      });

      conn.on('error', (err) => {
        if (!isHandled) {
          isHandled = true;
          clearTimeout(timeout);
          reject(new Error(`Gagal menghubungkan SSH: ${err.message}`));
        }
      });

      conn.connect(sshConfig);
    }
  });
}

/**
 * Fetch and validate sounds & video metadata against physical server files dynamically for POD V2 & V3
 */
async function validateSoundsMetadata(server) {
  const readJsonCmd = `(cat /home/pod/sounds/metadata.json 2>/dev/null || cat /home/pod/sounds/Metadata.json 2>/dev/null || echo "[]")`;
  // Recursive find command supporting both flat structure (POD V3) and subfolders (POD V2)
  const findFilesCmd = `(find /home/pod/sounds /home/pod/videos -type f -not -name "metadata.json*" -not -name "*.bak" 2>/dev/null || ls -1 /home/pod/sounds /home/pod/videos 2>/dev/null)`;

  const [rawJson, rawFilesList] = await Promise.all([
    executeCommand(server, readJsonCmd),
    executeCommand(server, findFilesCmd)
  ]);

  let metadata = [];
  try {
    const cleanJson = rawJson.trim();
    metadata = JSON.parse(cleanJson);
    if (!Array.isArray(metadata)) {
      metadata = [];
    }
  } catch (e) {
    throw new Error(`Format file metadata.json di server tidak valid: ${e.message}`);
  }

  // Maps & Sets for fast O(1) lookup
  const physicalFilesMap = new Map(); // key: basename, value: relativePath
  const fullPathSet = new Set();      // full path or relative path
  const physicalSounds = [];
  const physicalVideos = [];

  const rawLines = rawFilesList.split('\n').map(s => s.trim()).filter(Boolean);

  for (const line of rawLines) {
    // Normalize path by stripping /home/pod/
    let cleanPath = line.replace(/^\/home\/pod\//, '');
    const baseName = path.basename(cleanPath);

    physicalFilesMap.set(baseName.toLowerCase(), cleanPath);
    fullPathSet.add(cleanPath.toLowerCase());

    if (cleanPath.startsWith('videos/')) {
      physicalVideos.push(cleanPath);
    } else {
      physicalSounds.push(cleanPath);
    }
  }

  const referencedFileSet = new Set();
  const missingFiles = [];
  const processedItems = [];

  let totalExpectedFiles = 0;
  let totalMissingFiles = 0;
  let totalValidFiles = 0;

  metadata.forEach((item, index) => {
    const itemTitle = item.display || item.description || item.id || `Item #${index + 1}`;
    const filesInItem = [];

    // Helper to check a file field
    const checkFile = (filename, fieldName, category) => {
      if (!filename || typeof filename !== 'string' || !filename.trim()) return;
      const originalName = filename.trim();
      const baseName = path.basename(originalName).toLowerCase();
      totalExpectedFiles++;

      let exists = false;
      let foundPath = '';
      let defaultTargetFolder = category === 'video' ? 'videos/' : 'sounds/';

      // 1. Direct match by exact path or relative path
      if (fullPathSet.has(originalName.toLowerCase())) {
        exists = true;
        foundPath = originalName;
      }
      // 2. Match by basename across all subfolders (POD V2 dynamic subfolder lookup)
      else if (physicalFilesMap.has(baseName)) {
        exists = true;
        foundPath = physicalFilesMap.get(baseName);
      }

      if (exists) {
        totalValidFiles++;
        referencedFileSet.add(foundPath.toLowerCase());
      } else {
        totalMissingFiles++;
        missingFiles.push({
          filename: originalName,
          fieldName,
          category,
          targetFolder: defaultTargetFolder,
          itemId: item.id || index + 1,
          itemTitle
        });
      }

      filesInItem.push({
        filename: originalName,
        fieldName,
        category,
        targetFolder: defaultTargetFolder,
        foundPath: foundPath || defaultTargetFolder + originalName,
        exists
      });
    };

    if (item.filepath) checkFile(item.filepath, 'filepath', 'audio');
    if (item.strobepath) checkFile(item.strobepath, 'strobepath', 'audio');
    if (item.details && item.details.soundPath) checkFile(item.details.soundPath, 'details.soundPath', 'audio');
    if (item.video) checkFile(item.video, 'video', 'video');

    processedItems.push({
      ...item,
      __files: filesInItem,
      __hasMissing: filesInItem.some(f => !f.exists)
    });
  });

  // Calculate unreferenced extra physical files
  const unreferencedSounds = physicalSounds.filter(f => !referencedFileSet.has(f.toLowerCase()));
  const unreferencedVideos = physicalVideos.filter(f => !referencedFileSet.has(f.toLowerCase()));

  return {
    summary: {
      totalMetadataItems: metadata.length,
      totalExpectedFiles,
      totalMissingFiles,
      totalValidFiles,
      totalUnreferencedSounds: unreferencedSounds.length,
      totalUnreferencedVideos: unreferencedVideos.length,
      physicalSoundsCount: physicalSounds.length,
      physicalVideosCount: physicalVideos.length
    },
    items: processedItems,
    missingFiles,
    unreferencedSounds,
    unreferencedVideos
  };
}

module.exports = {
  validateSoundsMetadata
};
