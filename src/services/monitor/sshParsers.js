// Cache for previous network stats to calculate KB/s speed delta
const prevNetStats = {};

/**
 * Parse RAM from /proc/meminfo using 1:1 htop exact formula (MemTotal - MemAvailable)
 */
function parseRam(memText) {
  let memTotalKb = 0;
  let memFreeKb = 0;
  let buffersKb = 0;
  let cachedKb = 0;
  let sreclaimableKb = 0;
  let memAvailKb = 0;

  const memTotalMatch = memText.match(/MemTotal:\s+(\d+)/);
  const memFreeMatch = memText.match(/MemFree:\s+(\d+)/);
  const buffersMatch = memText.match(/Buffers:\s+(\d+)/);
  const cachedMatch = memText.match(/Cached:\s+(\d+)/);
  const sreclaimableMatch = memText.match(/SReclaimable:\s+(\d+)/);
  const memAvailMatch = memText.match(/MemAvailable:\s+(\d+)/);

  if (memTotalMatch) memTotalKb = parseInt(memTotalMatch[1], 10);
  if (memFreeMatch) memFreeKb = parseInt(memFreeMatch[1], 10);
  if (buffersMatch) buffersKb = parseInt(buffersMatch[1], 10);
  if (cachedMatch) cachedKb = parseInt(cachedMatch[1], 10);
  if (sreclaimableMatch) sreclaimableKb = parseInt(sreclaimableMatch[1], 10);
  if (memAvailMatch) memAvailKb = parseInt(memAvailMatch[1], 10);

  let usedKb = 0;
  let availKb = 0;

  if (memAvailKb > 0) {
    usedKb = Math.max(0, memTotalKb - memAvailKb);
    availKb = memAvailKb;
  } else {
    availKb = memFreeKb + buffersKb + cachedKb + sreclaimableKb;
    usedKb = Math.max(0, memTotalKb - availKb);
  }

  const ramTotalMb = Math.round(memTotalKb / 1024);
  const ramUsedMb = Math.round(usedKb / 1024);
  const ramFreeMb = Math.round(availKb / 1024);
  const ramUsage = ramTotalMb > 0 ? Math.round((ramUsedMb / ramTotalMb) * 1000) / 10 : 0;

  return { ramTotalMb, ramUsedMb, ramFreeMb, ramUsage };
}

/**
 * Parse CPU usage % and cores count from top & nproc
 */
function parseCpu(cpuText, coresText) {
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

  return { cpuUsage: Math.min(100, Math.max(0, cpuUsage)), cpuCores };
}

/**
 * Parse Disk usage & capacity from df -k
 */
function parseDisk(diskText) {
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

  return {
    diskUsage: Math.min(100, Math.max(0, diskUsage)),
    diskTotalGb,
    diskUsedGb,
    diskFreeGb
  };
}

/**
 * Parse Network bandwidth speed delta from /proc/net/dev
 */
function parseNet(netText, serverId) {
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
    bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
    bandwidthTxSpeed: Math.round(txSpeed * 10) / 10
  };
}

/**
 * Parse GPU stats from nvidia-smi CSV output
 */
function parseGpu(gpuText) {
  let gpuUsage = 0;
  let gpuMemoryUsage = 0;
  let gpuTemp = 0;
  let gpuName = 'N/A';

  if (gpuText) {
    const validLine = gpuText.split('\n').map(l => l.trim()).find(l => l.includes(','));
    if (validLine) {
      const parts = validLine.split(',').map(p => p.trim());
      if (parts.length >= 4 && parts[3]) {
        gpuUsage = Math.min(100, Math.max(0, parseFloat(parts[0]) || 0));
        gpuMemoryUsage = Math.min(100, Math.max(0, parseFloat(parts[1]) || 0));
        gpuTemp = Math.max(0, parseFloat(parts[2]) || 0);
        gpuName = parts[3];
      }
    }
  }

  return { gpuUsage, gpuMemoryUsage, gpuTemp, gpuName };
}

/**
 * Main parser assembling all sub-parsers into dual-alias object
 */
function parseSSHOutput(serverId, rawOutput, pingMs) {
  try {
    const sections = rawOutput.split(/---[A-Z]+---/);
    const memText = sections[0] || '';
    const freeText = sections[1] || '';
    const netText = sections[2] || '';
    const diskText = sections[3] || '';
    const cpuText = sections[4] || '';
    const gpuText = sections[5] ? sections[5].trim() : '';
    const coresText = sections[6] ? sections[6].trim() : '';

    const ram = parseRam(memText);
    const cpu = parseCpu(cpuText, coresText);
    const disk = parseDisk(diskText);
    const net = parseNet(netText, serverId);
    const gpu = parseGpu(gpuText);

    return {
      cpuUsage: cpu.cpuUsage,
      cpu_usage: cpu.cpuUsage,
      cpuCores: cpu.cpuCores,
      cpu_cores: cpu.cpuCores,

      ramUsage: ram.ramUsage,
      ram_usage: ram.ramUsage,
      ramUsedMb: ram.ramUsedMb,
      ram_used_mb: ram.ramUsedMb,
      ramFreeMb: ram.ramFreeMb,
      ram_free_mb: ram.ramFreeMb,
      ramTotalMb: ram.ramTotalMb,
      ram_total_mb: ram.ramTotalMb,

      bandwidthRxSpeed: net.bandwidthRxSpeed,
      bandwidth_rx_speed: net.bandwidthRxSpeed,
      bandwidthTxSpeed: net.bandwidthTxSpeed,
      bandwidth_tx_speed: net.bandwidthTxSpeed,

      diskUsage: disk.diskUsage,
      disk_usage: disk.diskUsage,
      diskUsedGb: disk.diskUsedGb,
      disk_used_gb: disk.diskUsedGb,
      diskTotalGb: disk.diskTotalGb,
      disk_total_gb: disk.diskTotalGb,
      diskFreeGb: disk.diskFreeGb,
      disk_free_gb: disk.diskFreeGb,

      gpuUsage: gpu.gpuUsage,
      gpu_usage: gpu.gpuUsage,
      gpuMemoryUsage: gpu.gpuMemoryUsage,
      gpu_memory_usage: gpu.gpuMemoryUsage,
      gpuName: gpu.gpuName,
      gpu_name: gpu.gpuName,
      gpuTemp: gpu.gpuTemp,
      gpu_temp: gpu.gpuTemp,

      pingMs,
      ping_ms: pingMs,
      status: 'online'
    };
  } catch (err) {
    console.error(`Error parsing SSH output for server ${serverId}:`, err.message);
    return {
      cpuUsage: 0,
      cpu_usage: 0,
      cpuCores: 1,
      cpu_cores: 1,
      ramUsage: 0,
      ram_usage: 0,
      ramUsedMb: 0,
      ram_used_mb: 0,
      ramFreeMb: 0,
      ram_free_mb: 0,
      ramTotalMb: 0,
      ram_total_mb: 0,
      bandwidthRxSpeed: 0,
      bandwidth_rx_speed: 0,
      bandwidthTxSpeed: 0,
      bandwidth_tx_speed: 0,
      diskUsage: 0,
      disk_usage: 0,
      diskUsedGb: 0,
      disk_used_gb: 0,
      diskTotalGb: 0,
      disk_total_gb: 0,
      diskFreeGb: 0,
      disk_free_gb: 0,
      gpuUsage: 0,
      gpu_usage: 0,
      gpuMemoryUsage: 0,
      gpu_memory_usage: 0,
      gpuName: 'N/A',
      gpu_name: 'N/A',
      gpuTemp: 0,
      gpu_temp: 0,
      pingMs,
      ping_ms: pingMs,
      status: 'online'
    };
  }
}

module.exports = {
  parseRam,
  parseCpu,
  parseDisk,
  parseNet,
  parseGpu,
  parseSSHOutput
};
