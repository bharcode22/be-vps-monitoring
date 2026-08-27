const { executeSshCommand } = require('../../utils/sshExecutor');
const { formatBytes } = require('../s3Service');

function executeCommand(server, command, timeoutMs = 60000, options = {}) {
  return executeSshCommand(server, command, { timeoutMs, ...options });
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

module.exports = {
  executeCommand,
  getPodStorageSummary
};
