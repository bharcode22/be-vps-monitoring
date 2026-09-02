const path = require('path');
const dbAsync = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');
const { getAuthToken } = require('./multimediaUploadService');

const MASTER_API_BASE = process.env.MASTER_API_BASE;

/**
 * 1. Fetch paginated list of multimedia from Master API
 */
async function fetchMasterMultimediaList(search = '', page = 1, limit = 12) {
  const token = await getAuthToken();
  const queryParams = new URLSearchParams({
    search: search || '',
    page: String(page || 1),
    limit: String(limit || 12)
  });

  const url = `${MASTER_API_BASE}/multimedia?${queryParams.toString()}`;
  console.log(`📡 Mengambil daftar multimedia dari global admin API`);

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    }
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Gagal mengambil multimedia dari Master API (HTTP ${res.status})`);
  }

  return data;
}

/**
 * 2. Inspect all POD v3 servers for:
 * - Docker container 'mobile-synch' state (running / exited / missing)
 */
async function inspectPodsSyncStatus(soundScapeCode = '') {
  const pods = await dbAsync.all("SELECT * FROM servers WHERE type = 'pod' AND pod_version = 'v3' ORDER BY id ASC");

  if (!pods || pods.length === 0) {
    return [];
  }

  // Inspect each POD in parallel with timeout safety
  const inspectPromises = pods.map(async (pod) => {
    const startTime = Date.now();
    const result = {
      serverId: pod.id,
      serverName: pod.name,
      host: pod.host,
      isOnline: false,
      pingMs: null,
      containerName: 'mobile-synch',
      containerState: 'unknown', // 'running' | 'exited' | 'missing' | 'unknown'
      containerStatus: 'Tidak terjangkau',
      error: null
    };

    try {
      // Single compact bash command to inspect docker container status
      const script = `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}' mobile-synch 2>/dev/null || docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}' mobile-sync 2>/dev/null || echo "MISSING"`;

      const stdout = await executeSshCommand(pod, script, { timeoutMs: 10000 });
      result.isOnline = true;
      result.pingMs = Date.now() - startTime;

      const statusPart = (stdout || '').trim();

      if (statusPart === 'MISSING' || !statusPart) {
        result.containerState = 'missing';
        result.containerStatus = 'Container tidak ditemukan';
      } else {
        const [status, isRunning, exitCode] = statusPart.split('|');
        if (isRunning === 'true' || status === 'running') {
          result.containerState = 'running';
          result.containerStatus = 'Running';
        } else {
          result.containerState = 'exited';
          result.containerStatus = `Exited (code: ${exitCode || '0'})`;
        }
      }
    } catch (err) {
      result.isOnline = false;
      result.error = err.message;
      result.containerState = 'unknown';
      result.containerStatus = 'Gagal terhubung via SSH';
    }

    return result;
  });

  return await Promise.all(inspectPromises);
}

/**
 * 2b. Inspect a single POD v3 server
 */
async function inspectSinglePodSyncStatus(serverId, soundScapeCode = '') {
  const pod = await dbAsync.get("SELECT * FROM servers WHERE id = ?", [serverId]);
  if (!pod) {
    throw new Error(`Server POD ID ${serverId} tidak ditemukan`);
  }

  const startTime = Date.now();
  const result = {
    serverId: pod.id,
    serverName: pod.name,
    host: pod.host,
    isOnline: false,
    pingMs: null,
    containerName: 'mobile-synch',
    containerState: 'unknown',
    containerStatus: 'Tidak terjangkau',
    error: null
  };

  try {
    const script = `docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}' mobile-synch 2>/dev/null || docker inspect --format '{{.State.Status}}|{{.State.Running}}|{{.State.ExitCode}}' mobile-sync 2>/dev/null || echo "MISSING"`;

    const stdout = await executeSshCommand(pod, script, { timeoutMs: 10000 });
    result.isOnline = true;
    result.pingMs = Date.now() - startTime;

    const statusPart = (stdout || '').trim();

    if (statusPart === 'MISSING' || !statusPart) {
      result.containerState = 'missing';
      result.containerStatus = 'Container tidak ditemukan';
    } else {
      const [status, isRunning, exitCode] = statusPart.split('|');
      if (isRunning === 'true' || status === 'running') {
        result.containerState = 'running';
        result.containerStatus = 'Running';
      } else {
        result.containerState = 'exited';
        result.containerStatus = `Exited (code: ${exitCode || '0'})`;
      }
    }
  } catch (err) {
    result.isOnline = false;
    result.error = err.message;
    result.containerState = 'unknown';
    result.containerStatus = 'Gagal terhubung via SSH';
  }

  return result;
}

/**
 * 3. Start, Restart, or Stop mobile-synch Docker container on a single POD
 */
async function controlPodSyncContainer(serverId, action = 'start', containerName = 'mobile-synch', soundScapeCode = '') {
  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!pod) {
    throw new Error(`Server POD ID ${serverId} tidak ditemukan`);
  }

  const safeContainerName = String(containerName || 'mobile-synch').replace(/[^a-zA-Z0-9_-]/g, '');
  const normalizedAction = ['start', 'restart', 'stop'].includes(action) ? action : 'start';

  let cmd = '';
  if (normalizedAction === 'stop') {
    cmd = `docker stop ${safeContainerName} 2>&1 || docker stop mobile-sync 2>&1`;
  } else if (normalizedAction === 'restart') {
    cmd = `
      if docker ps -a --format '{{.Names}}' | grep -Eq "^(${safeContainerName}|mobile-sync)$"; then
        docker restart ${safeContainerName} 2>&1 || docker restart mobile-sync 2>&1
      else
        COMPOSE_FILE=$(find $HOME -maxdepth 3 -name "docker-compose*.y*ml" -o -name "compose*.y*ml" 2>/dev/null | xargs grep -l "${safeContainerName}" 2>/dev/null | head -n 1)
        if [ -n "$COMPOSE_FILE" ]; then
          cd $(dirname "$COMPOSE_FILE") && (docker compose restart ${safeContainerName} 2>&1 || docker-compose restart ${safeContainerName} 2>&1)
        else
          echo "Container ${safeContainerName} tidak ditemukan di sistem Docker."
          exit 1
        fi
      fi
    `;
  } else {
    // start
    cmd = `
      if docker ps -a --format '{{.Names}}' | grep -Eq "^(${safeContainerName}|mobile-sync)$"; then
        docker start ${safeContainerName} 2>&1 || docker start mobile-sync 2>&1 || docker restart ${safeContainerName} 2>&1
      else
        COMPOSE_FILE=$(find $HOME -maxdepth 3 -name "docker-compose*.y*ml" -o -name "compose*.y*ml" 2>/dev/null | xargs grep -l "${safeContainerName}" 2>/dev/null | head -n 1)
        if [ -n "$COMPOSE_FILE" ]; then
          cd $(dirname "$COMPOSE_FILE") && (docker compose up -d ${safeContainerName} 2>&1 || docker-compose up -d ${safeContainerName} 2>&1)
        else
          echo "Container ${safeContainerName} tidak ditemukan di sistem Docker."
          exit 1
        fi
      fi
    `;
  }

  try {
    const stdout = await executeSshCommand(pod, cmd, { timeoutMs: 25000 });

    // Inspect fresh state of this POD only (fast ~150ms)
    let freshPodStatus = null;
    try {
      freshPodStatus = await inspectSinglePodSyncStatus(serverId, soundScapeCode);
    } catch (_) { }

    return {
      success: true,
      action: normalizedAction,
      serverId: pod.id,
      serverName: pod.name,
      output: stdout.trim(),
      podStatus: freshPodStatus
    };
  } catch (err) {
    throw new Error(`Gagal mengeksekusi aksi '${normalizedAction}' container di ${pod.name}: ${err.message}`);
  }
}

/**
 * 4. Batch control (start/restart/stop) mobile-synch containers on multiple PODs
 */
async function batchControlPodsSyncContainers(serverIds = [], action = 'start', containerName = 'mobile-synch') {
  if (!Array.isArray(serverIds) || serverIds.length === 0) {
    return { success: true, results: [] };
  }

  const results = await Promise.allSettled(
    serverIds.map(id => controlPodSyncContainer(id, action, containerName))
  );

  return {
    success: true,
    action,
    results: results.map((r, i) => {
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return {
        success: false,
        serverId: serverIds[i],
        action,
        error: r.reason?.message || `Gagal mengeksekusi ${action} container`
      };
    })
  };
}

// Backward compatibility aliases
const wakePodSyncContainer = (serverId, containerName) => controlPodSyncContainer(serverId, 'start', containerName);
const batchWakePodsSyncContainers = (serverIds, containerName) => batchControlPodsSyncContainers(serverIds, 'start', containerName);

/**
 * 5. Trigger Re-Save via RabbitMQ on Master API
 */
async function triggerMasterResave(soundScapeCode) {
  if (!soundScapeCode) {
    throw new Error('Kode sound_scape wajib disertakan untuk trigger re-save');
  }

  const cleanSoundScape = String(soundScapeCode).replace(/[^a-zA-Z0-9_-]/g, '');

  // Trigger Master API POST /admin-api/multimedia/re-save/{sound_scape}
  const token = await getAuthToken();
  const url = `${MASTER_API_BASE}/multimedia/re-save/${cleanSoundScape}`;
  console.log(`🚀 Mentrigger Master API Re-Save (${url})...`);

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({})
  });

  const responseText = await res.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch (_) { }

  if (!res.ok) {
    const errorMsg = responseJson?.message || responseJson?.error || responseText || `HTTP ${res.status}`;
    throw new Error(`Master API Re-Save Error: ${errorMsg}`);
  }

  return {
    success: true,
    soundScapeCode: cleanSoundScape,
    data: responseJson || { message: 'Re-save triggered successfully' }
  };
}

/**
 * 6. Fetch logs for mobile-synch container on a specific POD
 */
async function getPodSyncLogs(serverId, containerName = 'mobile-synch', lines = 50) {
  const pod = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
  if (!pod) {
    throw new Error(`Server POD ID ${serverId} tidak ditemukan`);
  }

  const safeName = String(containerName || 'mobile-synch').replace(/[^a-zA-Z0-9_-]/g, '');
  const limitLines = Math.min(Math.max(parseInt(lines, 10) || 50, 10), 300);

  const cmd = `docker logs --tail ${limitLines} ${safeName} 2>&1 || docker logs --tail ${limitLines} mobile-sync 2>&1`;

  try {
    const stdout = await executeSshCommand(pod, cmd, { timeoutMs: 15000 });
    return {
      success: true,
      serverId: pod.id,
      serverName: pod.name,
      containerName: safeName,
      logs: stdout || 'Tidak ada log yang tercatat.'
    };
  } catch (err) {
    throw new Error(`Gagal mengambil log container dari ${pod.name}: ${err.message}`);
  }
}

/**
 * 7. Delete multimedia item from Master API
 * DELETE /admin-api/multimedia/delete/:soundScape
 */
async function deleteMasterMultimedia(soundScapeCode) {
  if (!soundScapeCode) {
    throw new Error('Kode sound_scape wajib disertakan untuk menghapus multimedia');
  }

  const cleanSoundScape = String(soundScapeCode).replace(/[^a-zA-Z0-9_-]/g, '');
  const token = await getAuthToken();
  const url = `${MASTER_API_BASE}/multimedia/delete/${cleanSoundScape}`;
  console.log(`🗑️ Menghapus multimedia dari Master API (${url})...`);

  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': token,
      'Content-Type': 'application/json'
    }
  });

  const responseText = await res.text();
  let responseJson = null;
  try {
    responseJson = JSON.parse(responseText);
  } catch (_) { }

  if (!res.ok) {
    const errorMsg = responseJson?.message || responseJson?.error || responseText || `HTTP ${res.status}`;
    throw new Error(`Gagal menghapus multimedia di Master API: ${errorMsg}`);
  }

  return {
    success: true,
    soundScapeCode: cleanSoundScape,
    data: responseJson || { message: 'Multimedia berhasil dihapus' }
  };
}

module.exports = {
  fetchMasterMultimediaList,
  inspectPodsSyncStatus,
  inspectSinglePodSyncStatus,
  controlPodSyncContainer,
  batchControlPodsSyncContainers,
  wakePodSyncContainer,
  batchWakePodsSyncContainers,
  triggerMasterResave,
  getPodSyncLogs,
  deleteMasterMultimedia
};
