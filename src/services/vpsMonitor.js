const { Client } = require('ssh2');
const si = require('systeminformation');
const db = require('./db');

// Cache for previous network stats to calculate KB/s speed delta
const prevNetStats = {};

/**
 * Gather metrics for local server
 */
async function getLocalMetrics() {
  try {
    const startTime = Date.now();
    const load = await si.currentLoad();
    const mem = await si.mem();
    const net = await si.networkStats();
    const fs = await si.fsSize();
    const cpuInfo = await si.cpu();

    const ping = Date.now() - startTime;

    // Sum network speeds across active interfaces
    let rxSpeed = 0;
    let txSpeed = 0;
    if (net && net.length > 0) {
      net.forEach(iface => {
        if (!iface.internal) {
          rxSpeed += (iface.rx_sec || 0) / 1024; // KB/s
          txSpeed += (iface.tx_sec || 0) / 1024; // KB/s
        }
      });
    }

    const rootFs = fs.find(f => f.mount === '/') || fs[0] || { use: 0, size: 0, used: 0, available: 0 };

    const cpuCores = cpuInfo.cores || cpuInfo.physicalCores || 1;
    const ramUsedMb = Math.round(mem.active / (1024 * 1024));
    const ramTotalMb = Math.round(mem.total / (1024 * 1024));
    const ramFreeMb = Math.max(0, ramTotalMb - ramUsedMb);

    const diskTotalGb = Math.round(((rootFs.size || 0) / (1024 * 1024 * 1024)) * 10) / 10;
    const diskUsedGb = Math.round(((rootFs.used || 0) / (1024 * 1024 * 1024)) * 10) / 10;
    const diskFreeGb = Math.round(((rootFs.available || (rootFs.size - rootFs.used) || 0) / (1024 * 1024 * 1024)) * 10) / 10;

    // Fetch GPU Info if available locally
    let gpuUsage = 0;
    let gpuMemoryUsage = 0;
    let gpuName = 'N/A';
    let gpuTemp = 0;

    try {
      const graphics = await si.graphics();
      if (graphics && graphics.controllers && graphics.controllers.length > 0) {
        const gpu = graphics.controllers[0];
        gpuName = gpu.model || gpu.vendor || 'GPU Controller';
        gpuUsage = Math.round((gpu.utilizationGpu || 0) * 10) / 10;
        gpuMemoryUsage = Math.round((gpu.utilizationMemory || 0) * 10) / 10;
        gpuTemp = Math.round(gpu.temperatureGpu || 0);
      }
    } catch (e) {}

    return {
      cpuUsage: Math.round(load.currentLoad * 10) / 10,
      cpuCores,
      ramUsage: Math.round((mem.active / mem.total) * 1000) / 10,
      ramUsedMb,
      ramFreeMb,
      ramTotalMb,
      bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
      bandwidthTxSpeed: Math.round(txSpeed * 10) / 10,
      diskUsage: Math.round((rootFs.use || 0) * 10) / 10,
      diskUsedGb,
      diskTotalGb,
      diskFreeGb,
      gpuUsage,
      gpuMemoryUsage,
      gpuName,
      gpuTemp,
      pingMs: ping,
      status: 'online'
    };
  } catch (err) {
    console.error('Error fetching local metrics:', err.message);
    return {
      cpuUsage: 0,
      cpuCores: 1,
      ramUsage: 0,
      ramUsedMb: 0,
      ramFreeMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskFreeGb: 0,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: 'N/A',
      gpuTemp: 0,
      pingMs: 0,
      status: 'error'
    };
  }
}

/**
 * Gather metrics for remote VPS via SSH
 */
function getRemoteSSHMetrics(server) {
  return new Promise((resolve) => {
    const conn = new Client();
    const startTime = Date.now();
    let isHandled = false;

    const timeout = setTimeout(() => {
      if (!isHandled) {
        isHandled = true;
        conn.end();
        resolve({
          cpuUsage: 0,
          cpuCores: 1,
          ramUsage: 0,
          ramUsedMb: 0,
          ramFreeMb: 0,
          ramTotalMb: 0,
          bandwidthRxSpeed: 0,
          bandwidthTxSpeed: 0,
          diskUsage: 0,
          diskUsedGb: 0,
          diskTotalGb: 0,
          diskFreeGb: 0,
          gpuUsage: 0,
          gpuMemoryUsage: 0,
          gpuName: 'N/A',
          gpuTemp: 0,
          pingMs: 0,
          status: 'offline'
        });
      }
    }, 6000);

    const sshConfig = {
      host: server.host,
      port: server.port || 22,
      username: server.username || 'root',
      readyTimeout: 5000
    };

    if (server.auth_type === 'key' && server.private_key) {
      sshConfig.privateKey = server.private_key;
    } else {
      sshConfig.password = server.password;
    }

    conn.on('ready', () => {
      const cmd = `cat /proc/meminfo; echo "---NET---"; cat /proc/net/dev; echo "---DISK---"; df -k /; echo "---CPU---"; top -bn1 | head -n 5; echo "---GPU---"; nvidia-smi --query-gpu=utilization.gpu,utilization.memory,temperature.gpu,name --format=csv,noheader,nounits 2>/dev/null || echo "N/A"; echo "---CORES---"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "1"`;
      
      conn.exec(cmd, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          return resolve({
            status: 'error',
            cpuUsage: 0,
            cpuCores: 1,
            ramUsage: 0,
            ramUsedMb: 0,
            ramFreeMb: 0,
            ramTotalMb: 0,
            bandwidthRxSpeed: 0,
            bandwidthTxSpeed: 0,
            diskUsage: 0,
            diskUsedGb: 0,
            diskTotalGb: 0,
            diskFreeGb: 0,
            gpuUsage: 0,
            gpuMemoryUsage: 0,
            gpuName: 'N/A',
            gpuTemp: 0,
            pingMs: Date.now() - startTime
          });
        }

        let output = '';
        stream.on('close', () => {
          clearTimeout(timeout);
          conn.end();
          const pingMs = Date.now() - startTime;
          const parsed = parseSSHOutput(server.id, output, pingMs);
          if (!isHandled) {
            isHandled = true;
            resolve(parsed);
          }
        }).on('data', (data) => {
          output += data.toString();
        });
      });
    }).on('error', (err) => {
      clearTimeout(timeout);
      if (!isHandled) {
        isHandled = true;
        resolve({
          cpuUsage: 0,
          cpuCores: 1,
          ramUsage: 0,
          ramUsedMb: 0,
          ramFreeMb: 0,
          ramTotalMb: 0,
          bandwidthRxSpeed: 0,
          bandwidthTxSpeed: 0,
          diskUsage: 0,
          diskUsedGb: 0,
          diskTotalGb: 0,
          diskFreeGb: 0,
          gpuUsage: 0,
          gpuMemoryUsage: 0,
          gpuName: 'N/A',
          gpuTemp: 0,
          pingMs: 0,
          status: 'offline'
        });
      }
    }).connect(sshConfig);
  });
}

/**
 * Parse Linux output from SSH execution
 */
function parseSSHOutput(serverId, rawOutput, pingMs) {
  try {
    const sections = rawOutput.split(/---[A-Z]+---/);
    const memText = sections[0] || '';
    const netText = sections[1] || '';
    const diskText = sections[2] || '';
    const cpuText = sections[3] || '';
    const gpuText = sections[4] ? sections[4].trim() : '';
    const coresText = sections[5] ? sections[5].trim() : '';

    // 1. RAM Parsing (/proc/meminfo)
    let totalMemKb = 0;
    let availMemKb = 0;
    const memTotalMatch = memText.match(/MemTotal:\s+(\d+)/);
    const memAvailMatch = memText.match(/MemAvailable:\s+(\d+)/);
    if (memTotalMatch) totalMemKb = parseInt(memTotalMatch[1], 10);
    if (memAvailMatch) availMemKb = parseInt(memAvailMatch[1], 10);

    const usedMemKb = totalMemKb - availMemKb;
    const ramUsedMb = Math.round(usedMemKb / 1024);
    const ramTotalMb = Math.round(totalMemKb / 1024);
    const ramFreeMb = Math.max(0, ramTotalMb - ramUsedMb);
    const ramUsage = totalMemKb > 0 ? Math.round((usedMemKb / totalMemKb) * 1000) / 10 : 0;

    // 2. CPU Usage & Cores Parsing
    let cpuUsage = 0;
    const cpuLineMatch = cpuText.match(/%Cpu\(s\):\s+([\d.]+)\s+us,\s+([\d.]+)\s+sy,.*?([\d.]+)\s+id/);
    if (cpuLineMatch) {
      const idle = parseFloat(cpuLineMatch[3]);
      cpuUsage = Math.round((100 - idle) * 10) / 10;
    } else {
      const idleMatch = cpuText.match(/([\d.]+)\s*id/);
      if (idleMatch) {
        cpuUsage = Math.round((100 - parseFloat(idleMatch[1])) * 10) / 10;
      }
    }

    let cpuCores = 1;
    if (coresText) {
      cpuCores = parseInt(coresText, 10) || 1;
    }

    // 3. Disk Usage & Capacity Parsing (df -k /)
    let diskUsage = 0;
    let diskTotalGb = 0;
    let diskUsedGb = 0;
    let diskFreeGb = 0;

    const diskLines = diskText.trim().split('\n');
    if (diskLines.length >= 2) {
      const parts = diskLines[1].trim().split(/\s+/);
      if (parts.length >= 5) {
        const totalKb = parseInt(parts[1], 10) || 0;
        const usedKb = parseInt(parts[2], 10) || 0;
        const availKb = parseInt(parts[3], 10) || 0;
        const matchPct = parts[4].match(/(\d+)%/);
        if (matchPct) diskUsage = parseInt(matchPct[1], 10);
        
        diskTotalGb = Math.round((totalKb / 1048576) * 10) / 10;
        diskUsedGb = Math.round((usedKb / 1048576) * 10) / 10;
        diskFreeGb = Math.round((availKb / 1048576) * 10) / 10;
      }
    }

    // 4. Network Bandwidth Parsing (/proc/net/dev)
    let rxBytes = 0;
    let txBytes = 0;
    const netLines = netText.trim().split('\n');
    netLines.forEach(line => {
      if (line.includes(':')) {
        const parts = line.split(':')[1].trim().split(/\s+/);
        if (parts.length >= 9) {
          rxBytes += parseInt(parts[0], 10) || 0;
          txBytes += parseInt(parts[8], 10) || 0;
        }
      }
    });

    const now = Date.now();
    let rxSpeed = 0;
    let txSpeed = 0;

    if (prevNetStats[serverId]) {
      const timeDiffSec = (now - prevNetStats[serverId].timestamp) / 1000;
      if (timeDiffSec > 0) {
        rxSpeed = Math.max(0, (rxBytes - prevNetStats[serverId].rxBytes) / 1024 / timeDiffSec);
        txSpeed = Math.max(0, (txBytes - prevNetStats[serverId].txBytes) / 1024 / timeDiffSec);
      }
    }

    prevNetStats[serverId] = { rxBytes, txBytes, timestamp: now };

    // 5. GPU Parsing
    let gpuUsage = 0;
    let gpuMemoryUsage = 0;
    let gpuTemp = 0;
    let gpuName = 'N/A';

    if (gpuText && !gpuText.includes('N/A')) {
      const gpuLines = gpuText.split('\n');
      if (gpuLines.length > 0 && gpuLines[0].includes(',')) {
        const parts = gpuLines[0].split(',').map(p => p.trim());
        if (parts.length >= 4) {
          gpuUsage = Math.min(100, Math.max(0, parseFloat(parts[0]) || 0));
          gpuMemoryUsage = Math.min(100, Math.max(0, parseFloat(parts[1]) || 0));
          gpuTemp = Math.max(0, parseFloat(parts[2]) || 0);
          gpuName = parts[3] || 'NVIDIA GPU';
        }
      }
    }

    return {
      cpuUsage: Math.min(100, Math.max(0, cpuUsage)),
      cpuCores,
      ramUsage: Math.min(100, Math.max(0, ramUsage)),
      ramUsedMb,
      ramFreeMb,
      ramTotalMb,
      bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
      bandwidthTxSpeed: Math.round(txSpeed * 10) / 10,
      diskUsage: Math.min(100, Math.max(0, diskUsage)),
      diskUsedGb,
      diskTotalGb,
      diskFreeGb,
      gpuUsage,
      gpuMemoryUsage,
      gpuName,
      gpuTemp,
      pingMs,
      status: 'online'
    };
  } catch (err) {
    console.error(`Error parsing SSH output for server ${serverId}:`, err.message);
    return {
      cpuUsage: 0,
      cpuCores: 1,
      ramUsage: 0,
      ramUsedMb: 0,
      ramFreeMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskFreeGb: 0,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: 'N/A',
      gpuTemp: 0,
      pingMs,
      status: 'online'
    };
  }
}

/**
 * Poll all servers in database and record metrics
 */
async function collectAllServerMetrics(io) {
  const servers = await db.all('SELECT * FROM servers');
  const results = [];

  for (const server of servers) {
    let metrics;
    if (server.is_local === 1) {
      metrics = await getLocalMetrics();
    } else {
      metrics = await getRemoteSSHMetrics(server);
    }

    // Save to database metrics_history table
    await db.run(
      `INSERT INTO metrics_history (
        server_id, cpu_usage, cpu_cores, ram_usage, ram_used_mb, ram_free_mb, ram_total_mb,
        bandwidth_rx_speed, bandwidth_tx_speed, disk_usage, disk_used_gb, disk_total_gb, disk_free_gb,
        gpu_usage, gpu_memory_usage, gpu_name, gpu_temp, ping_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        server.id,
        metrics.cpuUsage,
        metrics.cpuCores,
        metrics.ramUsage,
        metrics.ramUsedMb,
        metrics.ramFreeMb,
        metrics.ramTotalMb,
        metrics.bandwidthRxSpeed,
        metrics.bandwidthTxSpeed,
        metrics.diskUsage,
        metrics.diskUsedGb,
        metrics.diskTotalGb,
        metrics.diskFreeGb,
        metrics.gpuUsage,
        metrics.gpuMemoryUsage,
        metrics.gpuName,
        metrics.gpuTemp,
        metrics.pingMs,
        metrics.status
      ]
    );

    results.push({
      ...server,
      // Hide raw passwords when sending to frontend
      password: server.password ? '******' : '',
      private_key: server.private_key ? '******' : '',
      currentMetrics: metrics
    });
  }

  // Cleanup history older than 24 hours to keep DB lightweight
  await db.run(`DELETE FROM metrics_history WHERE timestamp < datetime('now', '-24 hours')`);

  // Broadcast to Socket.io subscribers
  if (io) {
    io.emit('metrics_update', results);
  }

  return results;
}

module.exports = {
  getLocalMetrics,
  getRemoteSSHMetrics,
  collectAllServerMetrics
};
