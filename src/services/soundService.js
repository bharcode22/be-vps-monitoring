const { exec } = require('child_process');
const { Client } = require('ssh2');

/**
 * Execute command on local host or remote SSH server
 */
function executeCommand(server, command) {
  return new Promise((resolve, reject) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 30000 }, (error, stdout, stderr) => {
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
          reject(new Error('Koneksi SSH ke server waktu habis saat memproses data sounds (timeout 30 detik)'));
        }
      }, 30000);

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
 * Fetch and validate sounds & video metadata against physical server files
 */
async function validateSoundsMetadata(server) {
  const readJsonCmd = `(cat /home/pod/sounds/metadata.json 2>/dev/null || cat /home/pod/sounds/Metadata.json 2>/dev/null || echo "[]")`;
  const listSoundsCmd = `ls -1 /home/pod/sounds/ 2>/dev/null || echo ""`;
  const listVideosCmd = `ls -1 /home/pod/videos/ 2>/dev/null || echo ""`;

  const [rawJson, rawSoundsList, rawVideosList] = await Promise.all([
    executeCommand(server, readJsonCmd),
    executeCommand(server, listSoundsCmd),
    executeCommand(server, listVideosCmd)
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

  // Parse physical files in folders into Sets for O(1) fast lookup
  const physicalSounds = new Set(
    rawSoundsList
      .split('\n')
      .map(s => s.trim())
      .filter(s => s && s !== 'metadata.json' && s !== 'Metadata.json')
  );

  const physicalVideos = new Set(
    rawVideosList
      .split('\n')
      .map(s => s.trim())
      .filter(s => s)
  );

  const referencedSounds = new Set();
  const referencedVideos = new Set();
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
      const cleanName = filename.trim();
      totalExpectedFiles++;

      let exists = false;
      let folderPath = '/home/pod/sounds';

      if (category === 'video') {
        folderPath = '/home/pod/videos';
        referencedVideos.add(cleanName);
        exists = physicalVideos.has(cleanName);
      } else {
        referencedSounds.add(cleanName);
        exists = physicalSounds.has(cleanName);
      }

      if (exists) {
        totalValidFiles++;
      } else {
        totalMissingFiles++;
        missingFiles.push({
          filename: cleanName,
          fieldName,
          category,
          targetFolder: folderPath,
          itemId: item.id || index + 1,
          itemTitle
        });
      }

      filesInItem.push({
        filename: cleanName,
        fieldName,
        category,
        targetFolder: folderPath,
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

  // Calculate unreferenced extra files in folders
  const unreferencedSounds = Array.from(physicalSounds).filter(f => !referencedSounds.has(f));
  const unreferencedVideos = Array.from(physicalVideos).filter(f => !referencedVideos.has(f));

  return {
    summary: {
      totalMetadataItems: metadata.length,
      totalExpectedFiles,
      totalMissingFiles,
      totalValidFiles,
      totalUnreferencedSounds: unreferencedSounds.length,
      totalUnreferencedVideos: unreferencedVideos.length,
      physicalSoundsCount: physicalSounds.size,
      physicalVideosCount: physicalVideos.size
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
