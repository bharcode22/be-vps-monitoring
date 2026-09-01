const {
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
} = require('../services/multimediaSyncService');

/**
 * Get paginated list of multimedia from Master API
 */
const getMultimediaList = async (req, res) => {
  try {
    const { search, page, limit } = req.query;
    const result = await fetchMasterMultimediaList(search, page, limit);
    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Error fetching Master multimedia list:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memuat data multimedia dari Master API'
    });
  }
};

/**
 * Inspect container 'mobile-synch' & file status on all POD v3 servers
 */
const inspectFleetStatus = async (req, res) => {
  try {
    const soundScapeCode = req.query.soundScapeCode || req.body?.soundScapeCode || '';
    const fleet = await inspectPodsSyncStatus(soundScapeCode);
    return res.json({
      success: true,
      soundScapeCode,
      totalPods: fleet.length,
      onlinePods: fleet.filter(p => p.isOnline).length,
      runningPods: fleet.filter(p => p.containerState === 'running').length,
      exitedPods: fleet.filter(p => p.containerState === 'exited').length,
      data: fleet
    });
  } catch (err) {
    console.error('Error inspecting fleet sync status:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal memeriksa status POD V3'
    });
  }
};

/**
 * Inspect a single POD v3 server status
 */
const inspectSinglePodStatus = async (req, res) => {
  try {
    const { serverId } = req.params;
    const soundScapeCode = req.query.soundScapeCode || '';
    const result = await inspectSinglePodSyncStatus(serverId, soundScapeCode);
    return res.json({
      success: true,
      data: result
    });
  } catch (err) {
    console.error(`Error inspecting single pod ${req.params.serverId}:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

/**
 * Control (start/restart/stop) mobile-synch container on a single POD
 */
const controlContainer = async (req, res) => {
  try {
    const { serverId, action = 'start', containerName } = req.body;
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Parameter serverId wajib disertakan' });
    }
    const result = await controlPodSyncContainer(serverId, action, containerName);
    const actionLabel = action === 'stop' ? 'dihentikan' : action === 'restart' ? 'dimuat ulang (restart)' : 'dinyalakan';
    return res.json({
      success: true,
      message: `Container berhasil ${actionLabel} di ${result.serverName}`,
      data: result
    });
  } catch (err) {
    console.error(`Error controlling container on server ${req.body.serverId}:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

/**
 * Batch control (start/restart/stop) mobile-synch containers across multiple PODs
 */
const batchControlContainers = async (req, res) => {
  try {
    const { serverIds, action = 'start', containerName } = req.body;
    if (!serverIds || !Array.isArray(serverIds)) {
      return res.status(400).json({ success: false, error: 'Parameter serverIds (array) wajib disertakan' });
    }
    const result = await batchControlPodsSyncContainers(serverIds, action, containerName);
    return res.json(result);
  } catch (err) {
    console.error('Error batch controlling containers:', err.message);
    return res.status(500).json({
      success: false,
      error: err.message
    });
  }
};

// Aliases for backward compatibility
const wakeContainer = (req, res) => {
  req.body.action = 'start';
  return controlContainer(req, res);
};
const batchWakeContainers = (req, res) => {
  req.body.action = 'start';
  return batchControlContainers(req, res);
};

/**
 * Trigger re-save via RabbitMQ on Master API
 */
const triggerResave = async (req, res) => {
  try {
    const { soundScapeCode } = req.body;
    if (!soundScapeCode) {
      return res.status(400).json({ success: false, error: 'Parameter soundScapeCode wajib disertakan' });
    }
    const result = await triggerMasterResave(soundScapeCode);
    return res.json({
      success: true,
      message: `Pesan sinkronisasi RabbitMQ untuk #${soundScapeCode} berhasil dikirim ke Master API!`,
      data: result
    });
  } catch (err) {
    console.error(`Error triggering re-save for #${req.body?.soundScapeCode}:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mentrigger re-save ke Master API'
    });
  }
};

/**
 * Get container logs for mobile-synch on a specific POD
 */
const getContainerLogs = async (req, res) => {
  try {
    const { serverId } = req.params;
    const { containerName, lines } = req.query;
    const result = await getPodSyncLogs(serverId, containerName, lines);
    return res.json({
      success: true,
      data: result
    });
  } catch (err) {
    console.error(`Error fetching container logs for server ${req.params?.serverId}:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal mengambil log container'
    });
  }
};

/**
 * Delete multimedia item from Master API
 */
const deleteMultimedia = async (req, res) => {
  try {
    const { soundScapeCode } = req.params;
    if (!soundScapeCode) {
      return res.status(400).json({ success: false, error: 'Parameter soundScapeCode wajib disertakan' });
    }
    const result = await deleteMasterMultimedia(soundScapeCode);
    return res.json({
      success: true,
      message: `Multimedia #${soundScapeCode} berhasil dihapus dari Master API`,
      ...result
    });
  } catch (err) {
    console.error(`Error deleting master multimedia #${req.params?.soundScapeCode}:`, err.message);
    return res.status(500).json({
      success: false,
      error: err.message || 'Gagal menghapus multimedia dari Master API'
    });
  }
};

module.exports = {
  getMultimediaList,
  inspectFleetStatus,
  inspectSinglePodStatus,
  controlContainer,
  batchControlContainers,
  wakeContainer,
  batchWakeContainers,
  triggerResave,
  getContainerLogs,
  deleteMultimedia
};
