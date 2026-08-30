const dbAsync = require('../services/db');
const { getFileFlowEditorRecords } = require('../services/masterDbService');
const {
  getFlowEditorS3Files,
  checkFlowFilesOnSinglePod,
  checkFlowFilesOnAllPods,
  downloadFlowFilesToPod,
  deleteFlowFileFromPod,
  deleteFlowFileFromS3
} = require('../services/podStorage/flowEditorStorageService');
const { formatBytes } = require('../services/s3Service');

/**
 * 1. Get all Flow Editor files from Master RDS merged with S3 metadata
 */
const getFlowEditorFiles = async (req, res) => {
  try {
    const dbRecords = await getFileFlowEditorRecords();
    const files = await getFlowEditorS3Files(dbRecords);

    let totalS3Bytes = 0;
    let s3ExistsCount = 0;
    let imageCount = 0;
    let videoCount = 0;
    const placementCounts = {};

    for (const f of files) {
      if (f.existsInS3) {
        s3ExistsCount++;
        totalS3Bytes += f.sizeBytes;
      }
      if (f.category === 'image') imageCount++;
      else if (f.category === 'video') videoCount++;

      const p = f.placement || 'general';
      placementCounts[p] = (placementCounts[p] || 0) + 1;
    }

    const summary = {
      totalFiles: files.length,
      imageCount,
      videoCount,
      s3ExistsCount,
      s3MissingCount: files.length - s3ExistsCount,
      totalS3Bytes,
      totalS3Formatted: formatBytes(totalS3Bytes),
      placementCounts
    };

    res.json({
      success: true,
      data: {
        summary,
        files
      }
    });
  } catch (err) {
    console.error('Error fetching Flow Editor files:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 2. Cross-check Flow Editor files across all or specific POD V3 servers
 */
const checkFlowFilesOnPods = async (req, res) => {
  try {
    const { serverIds } = req.body || {};
    let servers = [];

    if (Array.isArray(serverIds) && serverIds.length > 0) {
      const placeholders = serverIds.map(() => '?').join(',');
      servers = await dbAsync.all(
        `SELECT * FROM servers WHERE id IN (${placeholders}) AND type = 'pod'`,
        serverIds
      );
    } else {
      servers = await dbAsync.all("SELECT * FROM servers WHERE type = 'pod' AND pod_version = 'v3'");
    }

    if (servers.length === 0) {
      return res.json({ success: true, data: {} });
    }

    const dbRecords = await getFileFlowEditorRecords();
    const flowFiles = await getFlowEditorS3Files(dbRecords);

    const podResults = await checkFlowFilesOnAllPods(servers, flowFiles);

    res.json({
      success: true,
      data: podResults
    });
  } catch (err) {
    console.error('Error cross-checking flow files on PODs:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 3. Download Flow Editor files to a single POD (Asynchronous Non-Blocking)
 */
const downloadFlowFilesToSinglePod = async (req, res) => {
  try {
    const { serverId, filenames } = req.body;
    if (!serverId) return res.status(400).json({ success: false, error: 'serverId wajib ditentukan' });
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ success: false, error: 'Daftar file tidak boleh kosong' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });

    const io = req.app.get('io');

    // 1. Immediately return HTTP 200 OK so browser/tunnel never times out
    res.json({
      success: true,
      status: 'started',
      message: `Proses download ${filenames.length} file ke ${server.name} dimulai di latar belakang...`,
      data: {
        serverId: server.id,
        serverName: server.name,
        totalRequested: filenames.length,
        filenames
      }
    });

    // 2. Execute download in background
    (async () => {
      try {
        const result = await downloadFlowFilesToPod(server, filenames, (progress) => {
          if (io) {
            io.emit('s3_pod_download_progress', {
              serverId: server.id,
              serverName: server.name,
              s3Code: 'flow_editor',
              filename: progress.filename,
              downloaded: progress.downloadedBytes,
              total: progress.totalBytes,
              downloadedFormatted: progress.downloadedFormatted,
              totalFormatted: progress.totalFormatted,
              percent: progress.percent,
              speed: progress.speed,
              status: progress.status
            });
          }
        });

        const isSuccess = result.errorCount === 0;
        const errorMsg = result.errorCount > 0
          ? result.downloads?.find(d => d.status === 'error')?.error || `${result.errorCount} file gagal didownload`
          : null;

        if (io) {
          io.emit('s3_pod_download_complete', {
            serverId: server.id,
            serverName: server.name,
            s3Code: 'flow_editor',
            success: isSuccess,
            error: errorMsg,
            successCount: result.successCount,
            totalRequested: result.totalRequested,
            totalDownloadedBytes: result.totalDownloadedBytes,
            totalDownloadedFormatted: result.totalDownloadedFormatted,
            filenames
          });
        }
      } catch (bgErr) {
        console.error(`[Background Flow Download Error on ${server.name}]:`, bgErr.message);
        if (io) {
          io.emit('s3_pod_download_complete', {
            serverId: server.id,
            serverName: server.name,
            s3Code: 'flow_editor',
            success: false,
            error: bgErr.message,
            filenames
          });
        }
      }
    })();
  } catch (err) {
    console.error('Error starting flow download to POD:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 4. Download Flow Editor files to multiple PODs in batch (Asynchronous Non-Blocking)
 */
const downloadFlowFilesToBatchPods = async (req, res) => {
  try {
    const { serverIds = [], filenames = [] } = req.body;
    if (!Array.isArray(serverIds) || serverIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Daftar serverIds wajib diisi' });
    }
    if (!Array.isArray(filenames) || filenames.length === 0) {
      return res.status(400).json({ success: false, error: 'Daftar filenames wajib diisi' });
    }

    const placeholders = serverIds.map(() => '?').join(',');
    const servers = await dbAsync.all(
      `SELECT * FROM servers WHERE id IN (${placeholders}) AND type = 'pod'`,
      serverIds
    );

    const io = req.app.get('io');

    res.json({
      success: true,
      status: 'started',
      message: `Proses batch download ${filenames.length} file ke ${servers.length} POD dimulai di latar belakang...`,
      data: {
        serverCount: servers.length,
        totalRequested: filenames.length,
        filenames
      }
    });

    (async () => {
      for (const server of servers) {
        try {
          const result = await downloadFlowFilesToPod(server, filenames, (progress) => {
            if (io) {
              io.emit('s3_pod_download_progress', {
                serverId: server.id,
                serverName: server.name,
                s3Code: 'flow_editor',
                filename: progress.filename,
                downloaded: progress.downloadedBytes,
                total: progress.totalBytes,
                downloadedFormatted: progress.downloadedFormatted,
                totalFormatted: progress.totalFormatted,
                percent: progress.percent,
                speed: progress.speed,
                status: progress.status
              });
            }
          });

          if (io) {
            io.emit('s3_pod_download_complete', {
              serverId: server.id,
              serverName: server.name,
              s3Code: 'flow_editor',
              success: result.errorCount === 0,
              error: result.errorCount > 0 ? `${result.errorCount} file gagal` : null,
              successCount: result.successCount,
              totalRequested: result.totalRequested,
              totalDownloadedFormatted: result.totalDownloadedFormatted,
              filenames
            });
          }
        } catch (serverErr) {
          console.error(`[Batch Flow Download Error on ${server.name}]:`, serverErr.message);
          if (io) {
            io.emit('s3_pod_download_complete', {
              serverId: server.id,
              serverName: server.name,
              s3Code: 'flow_editor',
              success: false,
              error: serverErr.message,
              filenames
            });
          }
        }
      }
    })();
  } catch (err) {
    console.error('Error starting batch flow download:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 5. Delete physical Flow Editor file on a specific POD
 */
const deleteFlowFileOnPod = async (req, res) => {
  try {
    const { serverId, filename, folderType } = req.body;
    if (!serverId) return res.status(400).json({ success: false, error: 'serverId wajib ditentukan' });
    if (!filename) return res.status(400).json({ success: false, error: 'filename wajib ditentukan' });

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });

    const result = await deleteFlowFileFromPod(server, filename, folderType);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error deleting flow file on POD:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 6. Delete file from S3 images/ prefix
 */
const deleteFlowFileOnS3 = async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ success: false, error: 'filename wajib ditentukan' });

    const result = await deleteFlowFileFromS3(filename);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error deleting flow file on S3:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getFlowEditorFiles,
  checkFlowFilesOnPods,
  downloadFlowFilesToSinglePod,
  downloadFlowFilesToBatchPods,
  deleteFlowFileOnPod,
  deleteFlowFileOnS3
};
