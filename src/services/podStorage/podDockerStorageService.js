const { executeCommand } = require('./podDiskService');
const { formatBytes } = require('../s3Service');

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
    throw new Error(
      `Server ${server.name} (${server.host}) sedang offline atau tidak dapat diakses SSH: ${err.message}`
    );
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
  inspectPodDockerStorage,
  cleanPodDockerStorage
};
