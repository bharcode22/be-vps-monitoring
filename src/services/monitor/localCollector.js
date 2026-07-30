const si = require('systeminformation');

/**
 * Gather metrics for local server (localhost)
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

    const rootFs = fs.find(f => f.mount === '/System/Volumes/Data') || fs.find(f => f.mount === '/') || fs[0] || { use: 0, size: 0, used: 0, available: 0 };

    const cpuCores = cpuInfo.cores || cpuInfo.physicalCores || 1;

    const ramTotalMb = Math.round((mem.total || 0) / (1024 * 1024));
    const usedBytes = (mem.active > 0)
      ? mem.active
      : ((mem.available > 0) ? (mem.total - mem.available) : mem.used);
    const availBytes = (mem.available > 0)
      ? mem.available
      : Math.max(0, mem.total - usedBytes);

    const ramUsedMb = Math.round((usedBytes || 0) / (1024 * 1024));
    const ramFreeMb = Math.round((availBytes || 0) / (1024 * 1024));
    const ramUsage = ramTotalMb > 0 ? Math.round((ramUsedMb / ramTotalMb) * 1000) / 10 : 0;

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
        const gpu = graphics.controllers.find(c => (c.model || c.vendor)) || graphics.controllers[0];
        const nameModel = (gpu.model || gpu.vendor || '').trim();
        if (nameModel && nameModel.toLowerCase() !== 'n/a') {
          gpuName = nameModel;
          gpuUsage = (gpu.utilizationGpu !== null && gpu.utilizationGpu !== undefined && !isNaN(gpu.utilizationGpu))
            ? Math.round((gpu.utilizationGpu || 0) * 10) / 10
            : 0;
          gpuMemoryUsage = (gpu.utilizationMemory !== null && gpu.utilizationMemory !== undefined && !isNaN(gpu.utilizationMemory))
            ? Math.round((gpu.utilizationMemory || 0) * 10) / 10
            : 0;
          gpuTemp = Math.round(gpu.temperatureGpu || 0);
        }
      }
    } catch (e) {
      gpuName = 'N/A';
      gpuUsage = 0;
      gpuMemoryUsage = 0;
      gpuTemp = 0;
    }

    return {
      cpuUsage: Math.round(load.currentLoad * 10) / 10,
      cpu_usage: Math.round(load.currentLoad * 10) / 10,
      cpuCores,
      cpu_cores: cpuCores,
      ramUsage: Math.round((mem.active / mem.total) * 1000) / 10,
      ram_usage: Math.round((mem.active / mem.total) * 1000) / 10,
      ramUsedMb,
      ram_used_mb: ramUsedMb,
      ramFreeMb,
      ram_free_mb: ramFreeMb,
      ramTotalMb,
      ram_total_mb: ramTotalMb,
      bandwidthRxSpeed: Math.round(rxSpeed * 10) / 10,
      bandwidth_rx_speed: Math.round(rxSpeed * 10) / 10,
      bandwidthTxSpeed: Math.round(txSpeed * 10) / 10,
      bandwidth_tx_speed: Math.round(txSpeed * 10) / 10,
      diskUsage: Math.round((rootFs.use || 0) * 10) / 10,
      disk_usage: Math.round((rootFs.use || 0) * 10) / 10,
      diskUsedGb,
      disk_used_gb: diskUsedGb,
      diskTotalGb,
      disk_total_gb: diskTotalGb,
      diskFreeGb,
      disk_free_gb: diskFreeGb,
      gpuUsage,
      gpu_usage: gpuUsage,
      gpuMemoryUsage,
      gpu_memory_usage: gpuMemoryUsage,
      gpuName,
      gpu_name: gpuName,
      gpuTemp,
      gpu_temp: gpuTemp,
      pingMs: ping,
      ping_ms: ping,
      status: 'online'
    };
  } catch (err) {
    console.error('Error fetching local metrics:', err.message);
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
      pingMs: 0,
      ping_ms: 0,
      status: 'error'
    };
  }
}

module.exports = {
  getLocalMetrics
};
