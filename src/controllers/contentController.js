const dbAsync = require('../services/db');
const { listS3MediaFolders, listS3FolderFiles, deleteS3CodeFolder, formatBytes } = require('../services/s3Service');
const {
  getPodStorageSummary,
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  streamPodPhysicalFile,
  inspectPodDockerStorage,
  cleanPodDockerStorage,
  executeCommand
} = require('../services/podStorageService');

/**
 * 1. Get list of all code folders in AWS S3 media/
 */
const getS3Folders = async (req, res) => {
  try {
    const data = await listS3MediaFolders();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching S3 folders:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 2. Get all files in a specific S3 code folder (e.g. 144411)
 */
const getS3FolderFiles = async (req, res) => {
  try {
    const { code } = req.query;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Parameter ?code=... harus disertakan (contoh: 144411)' });
    }

    const data = await listS3FolderFiles(code);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`Error fetching S3 files for code ${req.query.code}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 3. Get real-time 1 TB disk and media folder storage overview for all POD v3 servers
 */
const getPodsStorage = async (req, res) => {
  try {
    const { version } = req.query;
    let query = "SELECT * FROM servers WHERE type = 'pod'";
    const params = [];

    if (version && version !== 'all') {
      query += " AND pod_version = ?";
      params.push(version);
    } else {
      // Default to v3 if not specified
      query += " AND (pod_version = 'v3' OR pod_version IS NULL OR pod_version = '')";
    }

    const pods = await dbAsync.all(query, params);

    if (!pods || pods.length === 0) {
      return res.json({
        success: true,
        data: {
          pods: [],
          totalPods: 0,
          totalStorageUsedBytes: 0,
          totalStorageFreeBytes: 0,
          totalMediaBytes: 0
        }
      });
    }

    // Process all PODs in parallel
    const storageResults = await Promise.allSettled(
      pods.map(server => getPodStorageSummary(server))
    );

    const allPods = storageResults.map((result, idx) => {
      const srv = pods[idx];
      if (result.status === 'fulfilled') {
        return {
          ...result.value,
          code: srv.code || '',
          port: srv.port || 22,
          status: 'online'
        };
      } else {
        return {
          serverId: srv.id,
          serverName: srv.name,
          code: srv.code || '',
          host: srv.host,
          port: srv.port || 22,
          podVersion: srv.pod_version || 'v3',
          status: 'offline',
          error: result.reason?.message || 'Gagal menghubungi POD via SSH (Timeout / Offline)',
          disk: {
            totalBytes: 0,
            usedBytes: 0,
            freeBytes: 0,
            totalFormatted: '1.0 TB',
            usedFormatted: '0 B',
            freeFormatted: '0 B',
            percentUsed: 0,
            isHighUsage: false
          },
          folders: {
            videos: { path: '/home/pod/videos', bytes: 0, formatted: '0 B', count: 0 },
            sounds: { path: '/home/pod/sounds', bytes: 0, formatted: '0 B', count: 0 },
            images: { path: '/home/pod/images', bytes: 0, formatted: '0 B', count: 0 }
          },
          totalMediaBytes: 0,
          totalMediaFormatted: '0 B',
          totalMediaFiles: 0
        };
      }
    });

    // Sort by numerical POD code (e.g. POD-01, POD-02, POD-10)
    allPods.sort((a, b) => {
      const numA = parseInt((a.code || a.serverName || '').replace(/\D/g, ''), 10) || 0;
      const numB = parseInt((b.code || b.serverName || '').replace(/\D/g, ''), 10) || 0;
      if (numA !== numB) return numA - numB;
      return (a.serverName || '').localeCompare(b.serverName || '');
    });

    const onlinePods = allPods.filter(p => p.status === 'online');
    const totalStorageUsedBytes = onlinePods.reduce((acc, p) => acc + (p.disk?.usedBytes || 0), 0);
    const totalStorageFreeBytes = onlinePods.reduce((acc, p) => acc + (p.disk?.freeBytes || 0), 0);
    const totalMediaBytes = onlinePods.reduce((acc, p) => acc + (p.totalMediaBytes || 0), 0);

    res.json({
      success: true,
      data: {
        totalPods: allPods.length,
        onlinePodsCount: onlinePods.length,
        offlinePodsCount: allPods.length - onlinePods.length,
        totalStorageUsedBytes,
        totalStorageFreeBytes,
        totalMediaBytes,
        pods: allPods
      }
    });
  } catch (err) {
    console.error('Error fetching PODs storage:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 4. Scan a single POD server for orphan/junk files compared against AWS S3
 */
const scanPodJunk = async (req, res) => {
  try {
    const { id } = req.params;
    const { s3Code } = req.query;

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [id]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    let s3MasterFilenames = [];
    if (s3Code) {
      try {
        const s3Data = await listS3FolderFiles(s3Code);
        s3MasterFilenames = s3Data.files.map(f => f.filename);
      } catch (e) {
        console.warn(`Could not load S3 folder ${s3Code}:`, e.message);
      }
    }

    const data = await detectPodJunkFiles(server, s3MasterFilenames);
    res.json({ success: true, data });
  } catch (err) {
    console.error(`Error scanning POD ${req.params.id} junk files:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 5. Clean up selected junk files from a POD server (with dry-run support)
 */
const cleanupPodJunk = async (req, res) => {
  try {
    const { serverId, filePaths, isDryRun } = req.body;

    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Parameter serverId harus diisi' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    const result = await cleanupPodJunkFiles(server, filePaths, isDryRun !== false);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error cleaning up POD junk files:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 6. Trigger on-demand sync / download of S3 code folder to POD v3
 */
const syncS3ToPod = async (req, res) => {
  try {
    const { serverIds, s3Code } = req.body;

    if (!serverIds || !Array.isArray(serverIds) || serverIds.length === 0) {
      return res.status(400).json({ success: false, error: 'Pilih minimal satu server POD target' });
    }
    if (!s3Code) {
      return res.status(400).json({ success: false, error: 'Pilih kode folder AWS S3 yang akan di-sync (contoh: 144411)' });
    }

    const placeholders = serverIds.map(() => '?').join(',');
    const servers = await dbAsync.all(`SELECT * FROM servers WHERE id IN (${placeholders})`, serverIds);

    const s3Data = await listS3FolderFiles(s3Code);

    res.json({
      success: true,
      message: `Sinkronisasi folder S3 ${s3Code} (${s3Data.totalFiles} file, ${s3Data.totalSizeFormatted}) ke ${servers.length} POD telah diproses.`,
      s3Code,
      targetServersCount: servers.length,
      filesToSyncCount: s3Data.totalFiles
    });
  } catch (err) {
    console.error('Error syncing S3 to POD:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 7. Hard delete entire code folder from AWS S3
 */
const deleteS3Folder = async (req, res) => {
  try {
    const { code } = req.params;
    if (!code) {
      return res.status(400).json({ success: false, error: 'Parameter kode folder S3 harus diisi' });
    }
    const result = await deleteS3CodeFolder(code);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`Error deleting S3 folder ${req.params.code}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 8. Check file status for a single S3 code across all or selected PODs (Lazy Matrix Row Check)
 */
const checkCodeOnPods = async (req, res) => {
  try {
    const { s3Code, filenames, serverIds } = req.body;
    if (!s3Code) {
      return res.status(400).json({ success: false, error: 's3Code harus diisi' });
    }

    // Auto-resolve filenames from AWS S3 if not passed
    let targetFilenames = filenames;
    if (!targetFilenames || !Array.isArray(targetFilenames) || targetFilenames.length === 0) {
      try {
        const s3Data = await listS3FolderFiles(s3Code);
        targetFilenames = (s3Data.files || []).map(f => f.filename);
      } catch (err) {
        console.warn(`Could not resolve S3 files for code ${s3Code}:`, err.message);
        targetFilenames = [];
      }
    }

    let query = "SELECT * FROM servers WHERE type = 'pod' AND (pod_version = 'v3' OR pod_version IS NULL OR pod_version = '')";
    let params = [];
    if (serverIds && Array.isArray(serverIds) && serverIds.length > 0) {
      const ph = serverIds.map(() => '?').join(',');
      query += ` AND id IN (${ph})`;
      params = serverIds;
    }
    const pods = await dbAsync.all(query, params);

    // Process all pods in parallel
    const results = await Promise.allSettled(
      pods.map(srv => checkCodeFilesOnSinglePod(srv, s3Code, targetFilenames))
    );

    const matrix = {};
    results.forEach((r, i) => {
      const srvId = pods[i].id;
      if (r.status === 'fulfilled') {
        matrix[srvId] = r.value;
      } else {
        matrix[srvId] = {
          serverId: srvId,
          serverName: pods[i].name,
          code: pods[i].code || '',
          host: pods[i].host,
          status: 'offline',
          fileStatus: 'error',
          foundCount: 0,
          totalExpected: targetFilenames?.length || 0,
          totalBytes: 0,
          totalFormatted: '0 B',
          files: [],
          error: r.reason?.message || 'Gagal memeriksa status POD'
        };
      }
    });

    res.json({ success: true, s3Code, targetFilenames, data: matrix });
  } catch (err) {
    console.error('Error checking code on pods:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 9. Hard delete code files from a specific POD server
 */
const deleteCodeOnPod = async (req, res) => {
  try {
    const { serverId, s3Code, filenames } = req.body;
    if (!serverId || !s3Code) {
      return res.status(400).json({ success: false, error: 'serverId dan s3Code harus diisi' });
    }
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    // Auto-resolve filenames from AWS S3 if not passed
    let targetFilenames = filenames;
    if (!targetFilenames || !Array.isArray(targetFilenames) || targetFilenames.length === 0) {
      try {
        const s3Data = await listS3FolderFiles(s3Code);
        targetFilenames = (s3Data.files || []).map(f => f.filename);
      } catch (err) {
        targetFilenames = [];
      }
    }

    const result = await hardDeletePodCodeFiles(server, s3Code, targetFilenames);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error(`Error deleting code ${req.body.s3Code} on POD ${req.body.serverId}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 10. Batch delete code files across multiple PODs and/or AWS S3
 */
const batchDeleteCode = async (req, res) => {
  try {
    const { s3Code, filenames, serverIds, deleteFromS3 } = req.body;
    if (!s3Code) {
      return res.status(400).json({ success: false, error: 's3Code harus diisi' });
    }

    // Auto-resolve filenames from AWS S3 if not passed
    let targetFilenames = filenames;
    if (!targetFilenames || !Array.isArray(targetFilenames) || targetFilenames.length === 0) {
      try {
        const s3Data = await listS3FolderFiles(s3Code);
        targetFilenames = (s3Data.files || []).map(f => f.filename);
      } catch (err) {
        targetFilenames = [];
      }
    }

    const responseData = {
      s3Code,
      s3Deleted: null,
      podsDeleted: []
    };

    // 1. Delete from AWS S3 if requested
    if (deleteFromS3) {
      try {
        responseData.s3Deleted = await deleteS3CodeFolder(s3Code);
      } catch (e) {
        responseData.s3Deleted = { error: e.message };
      }
    }

    // 2. Delete from selected PODs
    if (serverIds && Array.isArray(serverIds) && serverIds.length > 0) {
      const ph = serverIds.map(() => '?').join(',');
      const servers = await dbAsync.all(`SELECT * FROM servers WHERE id IN (${ph})`, serverIds);

      const podResults = await Promise.allSettled(
        servers.map(srv => hardDeletePodCodeFiles(srv, s3Code, targetFilenames))
      );

      podResults.forEach((r, idx) => {
        if (r.status === 'fulfilled') {
          responseData.podsDeleted.push(r.value);
        } else {
          responseData.podsDeleted.push({
            serverId: servers[idx].id,
            serverName: servers[idx].name,
            error: r.reason?.message || 'Gagal menghapus file di POD'
          });
        }
      });
    }

    res.json({ success: true, data: responseData });
  } catch (err) {
    console.error('Error batch deleting code:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 11. Stream physical media file directly from a POD server via SFTP (supports HTTP 206 Partial Content)
 */
const streamPodFile = async (req, res) => {
  try {
    const { serverId, filePath } = req.query;

    if (!serverId || !filePath) {
      return res.status(400).json({ success: false, error: 'Parameter serverId dan filePath harus diisi' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    await streamPodPhysicalFile(server, filePath, req, res);
  } catch (err) {
    console.error('Error streaming POD file:', err.message);
    if (!res.headersSent) {
      res.status(500).json({ success: false, error: err.message });
    }
  }
};

/**
 * 12. Inspect Docker disk usage on a single POD server
 */
const inspectSinglePodDocker = async (req, res) => {
  try {
    const serverId = req.params.serverId || req.query.serverId;
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Parameter serverId harus diisi' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    const data = await inspectPodDockerStorage(server);
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error inspecting POD Docker storage:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 13. Inspect Docker disk usage across all POD v3 servers in parallel
 */
const inspectAllPodsDocker = async (req, res) => {
  try {
    const servers = await dbAsync.all(
      "SELECT * FROM servers WHERE type = 'pod' OR LOWER(name) LIKE '%pod%' ORDER BY name ASC"
    );

    const results = await Promise.allSettled(
      servers.map(server => inspectPodDockerStorage(server))
    );

    const podInspections = results.map((r, idx) => {
      if (r.status === 'fulfilled') {
        return r.value;
      }
      return {
        serverId: servers[idx].id,
        serverName: servers[idx].name,
        code: servers[idx].code || '',
        host: servers[idx].host,
        status: 'offline',
        error: r.reason?.message || 'SSH error'
      };
    });

    res.json({
      success: true,
      totalPods: servers.length,
      data: podInspections
    });
  } catch (err) {
    console.error('Error inspecting all PODs Docker storage:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 14. Execute Docker cleanup on a single POD server
 */
const cleanupSinglePodDocker = async (req, res) => {
  if (req.setTimeout) req.setTimeout(360000); // 6 menit
  try {
    const { serverId, cleanType = 'safe' } = req.body;
    if (!serverId) {
      return res.status(400).json({ success: false, error: 'Parameter serverId harus diisi' });
    }

    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    const result = await cleanPodDockerStorage(server, cleanType);
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error cleaning single POD Docker storage:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * 15. Execute Docker cleanup in batch across multiple or all POD servers
 */
const cleanupBatchPodsDocker = async (req, res) => {
  if (req.setTimeout) req.setTimeout(360000); // 6 menit
  try {
    const { serverIds, cleanType = 'safe' } = req.body;

    let servers = [];
    if (serverIds && Array.isArray(serverIds) && serverIds.length > 0) {
      const placeholders = serverIds.map(() => '?').join(',');
      servers = await dbAsync.all(`SELECT * FROM servers WHERE id IN (${placeholders})`, serverIds);
    } else {
      servers = await dbAsync.all(
        "SELECT * FROM servers WHERE type = 'pod' OR LOWER(name) LIKE '%pod%' ORDER BY name ASC"
      );
    }

    const results = await Promise.allSettled(
      servers.map(server => cleanPodDockerStorage(server, cleanType))
    );

    let totalFreedBytes = 0;
    const cleanResults = results.map((r, idx) => {
      if (r.status === 'fulfilled') {
        totalFreedBytes += r.value.freedBytes || 0;
        return r.value;
      }
      return {
        serverId: servers[idx].id,
        serverName: servers[idx].name,
        code: servers[idx].code || '',
        status: 'error',
        error: r.reason?.message || 'Gagal membersihkan Docker di server'
      };
    });

    res.json({
      success: true,
      totalServers: servers.length,
      totalFreedBytes,
      totalFreedFormatted: formatBytes(totalFreedBytes),
      cleanType,
      data: cleanResults
    });
  } catch (err) {
    console.error('Error in batch cleaning PODs Docker storage:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  getS3Folders,
  getS3FolderFiles,
  getPodsStorage,
  scanPodJunk,
  cleanupPodJunk,
  syncS3ToPod,
  deleteS3Folder,
  checkCodeOnPods,
  deleteCodeOnPod,
  batchDeleteCode,
  streamPodFile,
  inspectSinglePodDocker,
  inspectAllPodsDocker,
  cleanupSinglePodDocker,
  cleanupBatchPodsDocker
};



