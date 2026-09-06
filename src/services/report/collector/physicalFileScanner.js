const path = require('path');
const { executeSshCommand } = require('../../../utils/sshExecutor');

/**
 * Scan all physical media files in POD (/home/pod/sounds, /home/pod/videos, /home/pod/images)
 * in one single SSH execution
 */
async function scanPodPhysicalFiles(podServer) {
  const findCmd = `
    find /home/pod/sounds /home/pod/videos /home/pod/images -type f -printf "%p|%s\\n" 2>/dev/null || \
    find /home/pod/sounds /home/pod/videos /home/pod/images -type f 2>/dev/null
  `;

  try {
    const res = await executeSshCommand(podServer, findCmd, { timeoutMs: 20000 });
    const stdout = typeof res === 'string' ? res : (res && res.stdout ? res.stdout : '');
    const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean);

    const soundsMap = new Map(); // filename (lowercase) -> { fullPath, fileName, sizeBytes }
    const videosMap = new Map();
    const imagesMap = new Map();

    for (const line of lines) {
      const [fullPath, sizeStr] = line.split('|');
      const cleanPath = (fullPath || '').trim();
      if (!cleanPath) continue;

      const sizeBytes = sizeStr ? parseInt(sizeStr.trim(), 10) || 0 : null;
      const fileName = path.basename(cleanPath);
      const fileKey = fileName.toLowerCase().trim();

      const itemInfo = {
        fullPath: cleanPath,
        fileName,
        sizeBytes
      };

      if (cleanPath.startsWith('/home/pod/sounds')) {
        soundsMap.set(fileKey, itemInfo);
      } else if (cleanPath.startsWith('/home/pod/videos')) {
        videosMap.set(fileKey, itemInfo);
      } else if (cleanPath.startsWith('/home/pod/images')) {
        imagesMap.set(fileKey, itemInfo);
      }
    }

    return {
      success: true,
      soundsMap,
      videosMap,
      imagesMap,
      totalScanned: soundsMap.size + videosMap.size + imagesMap.size
    };
  } catch (err) {
    console.warn(`[Report Collector] Gagal memindai file fisik POD via SSH (${podServer.name}):`, err.message);
    return {
      success: false,
      soundsMap: new Map(),
      videosMap: new Map(),
      imagesMap: new Map(),
      totalScanned: 0,
      error: err.message
    };
  }
}

module.exports = {
  scanPodPhysicalFiles
};
