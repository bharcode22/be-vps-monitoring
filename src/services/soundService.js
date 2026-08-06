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

// /**
//  * Fetch and compare sound & video files across multiple PODs
//  */
async function compareSoundsForPods(pods) {
  if (!pods || pods.length === 0) {
    return { pods: [], files: {} };
  }

  // Recursive find command supporting both flat structure (POD V3) and subfolders (POD V2)
  const findFilesCmd = `(find /home/pod/sounds /home/pod/videos -type f -not -name "metadata.json*" -not -name "*.bak" 2>/dev/null || ls -1 /home/pod/sounds /home/pod/videos 2>/dev/null)`;

  // Concurrent execution for all pods
  const promises = pods.map(async (server) => {
    try {
      const rawFilesList = await executeCommand(server, findFilesCmd);
      const rawLines = rawFilesList.split('\n').map(s => s.trim()).filter(Boolean);

      const filePaths = [];
      const baseNamesMap = new Map();

      for (const line of rawLines) {
        let cleanPath = line.replace(/^\/home\/pod\//, '');
        const baseName = path.basename(cleanPath).toLowerCase();

        filePaths.push(cleanPath);
        baseNamesMap.set(baseName, cleanPath);
      }

      return {
        serverId: server.id,
        success: true,
        filePaths,
        baseNamesMap
      };
    } catch (err) {
      console.error(`Failed to fetch sounds from pod ${server.name} (${server.host}): ${err.message}`);
      return {
        serverId: server.id,
        success: false,
        error: err.message,
        filePaths: [],
        baseNamesMap: new Map()
      };
    }
  });

  const results = await Promise.all(promises);

  // Collect all unique basenames across all successful pods
  const allUniqueFiles = new Map(); // key: basename, value: example relative path

  results.forEach(res => {
    if (res.success) {
      res.baseNamesMap.forEach((relPath, baseName) => {
        if (!allUniqueFiles.has(baseName)) {
          allUniqueFiles.set(baseName, relPath); // store at least one valid path for display
        }
      });
    }
  });

  const filesMatrix = {}; // { 'filename.mp3': { '1': true, '2': false }, ... }

  // Sort files alphabetically for better UI
  const sortedBaseNames = Array.from(allUniqueFiles.keys()).sort();

  sortedBaseNames.forEach(baseName => {
    const originalPath = allUniqueFiles.get(baseName);

    // Check presence in each pod
    const podsPresence = {};
    const podsPaths = {};
    let presentCount = 0;

    results.forEach(res => {
      const exists = res.baseNamesMap.has(baseName);
      podsPresence[res.serverId] = exists;
      if (exists) {
        podsPaths[res.serverId] = res.baseNamesMap.get(baseName);
        presentCount++;
      }
    });

    filesMatrix[baseName] = {
      originalPath,
      isMissingInSome: presentCount > 0 && presentCount < results.length, // True if at least one pod doesn't have it
      podsPresence,
      podsPaths
    };
  });

  // Map pod info for the frontend
  const podsInfo = pods.map(p => ({
    id: p.id,
    name: p.name,
    host: p.host,
    pod_version: p.pod_version,
    fetchSuccess: results.find(r => r.serverId === p.id)?.success || false,
    error: results.find(r => r.serverId === p.id)?.error
  }));

  return {
    pods: podsInfo,
    files: filesMatrix,
    totalFiles: sortedBaseNames.length
  };
}

/**
 * Fetch and compare metadata.json across multiple PODs
 * @param {Array} pods - Array of pod servers
 */
async function compareMetadataForPods(pods) {
  if (!pods || pods.length === 0) {
    return { pods: [], metadataMatrix: {} };
  }

  const catMetadataCmd = `cat /home/pod/sounds/metadata.json 2>/dev/null`;

  const promises = pods.map(async (server) => {
    try {
      const rawJson = await executeCommand(server, catMetadataCmd);
      if (!rawJson.trim()) {
        throw new Error("metadata.json empty or not found");
      }
      const parsed = JSON.parse(rawJson);
      
      return {
        serverId: server.id,
        success: true,
        data: parsed
      };
    } catch (err) {
      console.error(`Failed to fetch/parse metadata from pod ${server.name} (${server.host}): ${err.message}`);
      return {
        serverId: server.id,
        success: false,
        error: err.message,
        data: []
      };
    }
  });

  const results = await Promise.all(promises);

  const allMetadataKeys = new Map(); // key: "SessionName|ID", value: { session, id }
  
  results.forEach(res => {
    if (res.success && Array.isArray(res.data)) {
      res.data.forEach(item => {
        // Both session and id must exist to compare. If session is missing, we use 'Unknown Session'.
        const session = item.session || 'Unknown Session';
        const id = item.id;
        if (id !== undefined) {
          const key = `${session}|${id}`;
          if (!allMetadataKeys.has(key)) {
            allMetadataKeys.set(key, { session, id });
          }
        }
      });
    }
  });

  const metadataMatrix = {};
  const sortedKeys = Array.from(allMetadataKeys.keys()).sort();

  sortedKeys.forEach(key => {
    const { session, id } = allMetadataKeys.get(key);
    
    const podsPresence = {}; // { serverId: true/false }
    const podsFilepaths = {}; // { serverId: "filepath..." }
    let uniqueFilepaths = new Set();
    let presentCount = 0;
    
    results.forEach(res => {
      if (res.success && Array.isArray(res.data)) {
        const found = res.data.find(x => (x.session || 'Unknown Session') === session && String(x.id) === String(id));
        podsPresence[res.serverId] = !!found;
        if (found) {
          const fp = found.filepath || "";
          podsFilepaths[res.serverId] = fp;
          uniqueFilepaths.add(fp);
          presentCount++;
        }
      } else {
        podsPresence[res.serverId] = false;
      }
    });

    metadataMatrix[key] = {
      session,
      id,
      isMismatch: uniqueFilepaths.size > 1, // filepaths are different across pods that have it
      isMissingInSome: presentCount > 0 && presentCount < results.filter(r => r.success).length, // some successful pods don't have this item at all
      podsPresence,
      podsFilepaths
    };
  });

  const podsInfo = pods.map(p => ({
    id: p.id,
    name: p.name,
    host: p.host,
    pod_version: p.pod_version,
    fetchSuccess: results.find(r => r.serverId === p.id)?.success || false,
    error: results.find(r => r.serverId === p.id)?.error
  }));

  return {
    pods: podsInfo,
    metadataMatrix,
    totalItems: sortedKeys.length
  };
}

module.exports = {
  executeCommand,
  validateSoundsMetadata,
  compareSoundsForPods,
  compareMetadataForPods
};
