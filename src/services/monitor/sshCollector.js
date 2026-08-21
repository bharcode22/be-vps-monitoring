const { Client } = require('ssh2');
const { parseSSHOutput } = require('./sshParsers');
const { decrypt } = require('../../utils/crypto');

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
      sshConfig.privateKey = decrypt(server.private_key);
    } else {
      sshConfig.password = decrypt(server.password);
    }

    conn.on('ready', () => {
      const cmd = `cat /proc/meminfo; echo "---FREE---"; free -m 2>/dev/null || echo "N/A"; echo "---NET---"; cat /proc/net/dev; echo "---DISK---"; df -k /System/Volumes/Data 2>/dev/null || df -k /; echo "---CPU---"; top -bn1 | head -n 5; echo "---GPU---"; nvidia-smi --query-gpu=utilization.gpu,utilization.memory,temperature.gpu,name --format=csv,noheader,nounits 2>/dev/null || echo "N/A"; echo "---CORES---"; nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo 2>/dev/null || echo "1"`;

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
        try { conn.end(); } catch (e) {}
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
    });

    try {
      conn.connect(sshConfig);
    } catch (connErr) {
      clearTimeout(timeout);
      if (!isHandled) {
        isHandled = true;
        try { conn.end(); } catch (e) {}
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
    }
  });
}

module.exports = {
  getRemoteSSHMetrics
};
