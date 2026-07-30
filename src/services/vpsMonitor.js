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

    const rootFs = fs.find(f => f.mount === '/') || fs[0] || { use: 0 };

    return {
      cpuUsage: Math.round(load.currentLoad * 10) / 10,
      ramUsage: Math.round((mem.active / mem.total) * 1000) / 10,
      ramUsedMb: Math.round(mem.active / (1024 * 1024)),
      ramTotalMb: Math.round(mem.total / (1024 * 1024)),
      bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
      bandwidthTxSpeed: Math.round(txSpeed * 10) / 10,
      diskUsage: Math.round((rootFs.use || 0) * 10) / 10,
      pingMs: ping,
      status: 'online'
    };
  } catch (err) {
    console.error('Error fetching local metrics:', err.message);
    return {
      cpuUsage: 0,
      ramUsage: 0,
      ramUsedMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
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
          ramUsage: 0,
          ramUsedMb: 0,
          ramTotalMb: 0,
          bandwidthRxSpeed: 0,
          bandwidthTxSpeed: 0,
          diskUsage: 0,
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
      const cmd = `cat /proc/meminfo; echo "---NET---"; cat /proc/net/dev; echo "---DISK---"; df -k /; echo "---CPU---"; top -bn1 | head -n 5`;
      
      conn.exec(cmd, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          conn.end();
          return resolve({ status: 'error', cpuUsage: 0, ramUsage: 0, ramUsedMb: 0, ramTotalMb: 0, bandwidthRxSpeed: 0, bandwidthTxSpeed: 0, diskUsage: 0, pingMs: Date.now() - startTime });
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
          ramUsage: 0,
          ramUsedMb: 0,
          ramTotalMb: 0,
          bandwidthRxSpeed: 0,
          bandwidthTxSpeed: 0,
          diskUsage: 0,
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
    const ramUsage = totalMemKb > 0 ? Math.round((usedMemKb / totalMemKb) * 1000) / 10 : 0;

    // 2. CPU Usage Parsing (from top output)
    let cpuUsage = 0;
    const cpuLineMatch = cpuText.match(/%Cpu\(s\):\s+([\d.]+)\s+us,\s+([\d.]+)\s+sy,.*?([\d.]+)\s+id/);
    if (cpuLineMatch) {
      const idle = parseFloat(cpuLineMatch[3]);
      cpuUsage = Math.round((100 - idle) * 10) / 10;
    } else {
      // Fallback regex
      const idleMatch = cpuText.match(/([\d.]+)\s*id/);
      if (idleMatch) {
        cpuUsage = Math.round((100 - parseFloat(idleMatch[1])) * 10) / 10;
      }
    }

    // 3. Disk Usage Parsing (df -k /)
    let diskUsage = 0;
    const diskLines = diskText.trim().split('\n');
    if (diskLines.length >= 2) {
      const matchPct = diskLines[1].match(/(\d+)%/);
      if (matchPct) {
        diskUsage = parseInt(matchPct[1], 10);
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

    return {
      cpuUsage: Math.min(100, Math.max(0, cpuUsage)),
      ramUsage: Math.min(100, Math.max(0, ramUsage)),
      ramUsedMb,
      ramTotalMb,
      bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
      bandwidthTxSpeed: Math.round(txSpeed * 10) / 10,
      diskUsage: Math.min(100, Math.max(0, diskUsage)),
      pingMs,
      status: 'online'
    };
  } catch (err) {
    console.error(`Error parsing SSH output for server ${serverId}:`, err.message);
    return {
      cpuUsage: 0,
      ramUsage: 0,
      ramUsedMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
      pingMs,
      status: 'online'
    };
  }
}

/**
 * Poll all servers in database and record metrics
 */
async function collectAllServerMetrics(io) {
  const servers = db.prepare('SELECT * FROM servers').all();
  const results = [];

  for (const server of servers) {
    let metrics;
    if (server.is_local === 1) {
      metrics = await getLocalMetrics();
    } else {
      metrics = await getRemoteSSHMetrics(server);
    }

    // Save to database metrics_history table
    db.prepare(`
      INSERT INTO metrics_history (
        server_id, cpu_usage, ram_usage, ram_used_mb, ram_total_mb,
        bandwidth_rx_speed, bandwidth_tx_speed, disk_usage, ping_ms, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      server.id,
      metrics.cpuUsage,
      metrics.ramUsage,
      metrics.ramUsedMb,
      metrics.ramTotalMb,
      metrics.bandwidthRxSpeed,
      metrics.bandwidthTxSpeed,
      metrics.diskUsage,
      metrics.pingMs,
      metrics.status
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
  db.prepare(`DELETE FROM metrics_history WHERE timestamp < datetime('now', '-24 hours')`).run();

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
