const fs = require('fs');
const path = require('path');
const dbAsync = require('../services/db');
const { collectFullPodReportData } = require('../services/report/podReportCollectorService');
const { generatePodPdfReport, REPORTS_DIR: GENERATOR_REPORTS_DIR } = require('../services/report/podPdfGeneratorService');
const { getTelegramAlertConfig } = require('../services/telegramAlertService');
const { sendTelegramPdfDocument } = require('../services/telegramBotListenerService');

/**
 * Resolve report directory with multi-path support
 */
function getCandidateReportDirs() {
  const dirs = [];
  if (GENERATOR_REPORTS_DIR && fs.existsSync(GENERATOR_REPORTS_DIR)) {
    dirs.push(GENERATOR_REPORTS_DIR);
  }
  const dir1 = path.join(__dirname, '../data/reports'); // backend/src/data/reports
  if (!dirs.includes(dir1)) dirs.push(dir1);
  const dir2 = path.join(__dirname, '../../data/reports'); // backend/data/reports
  if (!dirs.includes(dir2) && fs.existsSync(dir2)) dirs.push(dir2);

  // Ensure main directory exists
  if (!fs.existsSync(dir1)) {
    fs.mkdirSync(dir1, { recursive: true });
  }
  return dirs;
}

function findReportFilePath(rawFileName) {
  const safeFileName = path.basename(rawFileName);
  const dirs = getCandidateReportDirs();
  for (const d of dirs) {
    const candidate = path.join(d, safeFileName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * POST /api/reports/generate/:serverId
 * Generate PDF report on demand via web dashboard API
 */
async function generateReportHandler(req, res) {
  try {
    const serverId = parseInt(req.params.serverId, 10);
    const podServer = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);

    if (!podServer) {
      return res.status(404).json({ success: false, error: 'Server tidak ditemukan.' });
    }

    console.log(`📊 [API Report] Menerima permintaan generate laporan untuk ${podServer.name}...`);
    const reportData = await collectFullPodReportData(podServer);
    const { filePath, fileName, fileSizeBytes } = await generatePodPdfReport(reportData);

    const sendToTelegram = req.query?.sendTelegram === 'true' || req.body?.sendTelegram === true;
    let telegramSent = false;

    if (sendToTelegram) {
      const config = getTelegramAlertConfig();
      if (config.botToken && config.chatId) {
        const caption = `📊 <b>Laporan PDF Manual: ${podServer.name}</b>\nHealth Score: ${reportData.scores.overallHealthScore}%`;
        await sendTelegramPdfDocument(config.chatId, filePath, fileName, caption);
        telegramSent = true;
      }
    }

    return res.json({
      success: true,
      message: `Laporan ${fileName} berhasil dibuat.`,
      fileName,
      downloadUrl: `/api/reports/download/${encodeURIComponent(fileName)}`,
      fileSizeBytes,
      healthScore: reportData.scores.overallHealthScore,
      scores: reportData.scores,
      telegramSent,
      summary: {
        topicsMatched: reportData.topics.podTopics.matchedCount,
        topicsTotal: reportData.topics.podTopics.totalMaster,
        heartbeatUptime: reportData.heartbeat.averageUptimePct,
        heartbeatLive: reportData.heartbeat.liveModulesCount,
        heartbeatTotal: reportData.heartbeat.totalModulesTracked,
        heartbeatPackets: reportData.heartbeat.totalPacketsLastHour,
        heartbeatStorage: reportData.heartbeat.storageLocation,
        signatureReady: reportData.signature.totalFilesReady,
        signatureTotal: reportData.signature.totalFilesChecked,
        exploreReady: reportData.explore.totalFilesReady,
        exploreTotal: reportData.explore.totalFilesChecked
      }
    });
  } catch (err) {
    console.error('Error in generateReportHandler:', err);
    return res.status(500).json({
      success: false,
      error: `Gagal membuat laporan: ${err.message}`
    });
  }
}

/**
 * GET /api/reports/download/:filename
 * Download / Preview PDF report
 */
async function downloadReportHandler(req, res) {
  try {
    const rawFileName = req.params.filename;
    const safeFileName = path.basename(rawFileName);
    const filePath = findReportFilePath(safeFileName);

    if (!filePath || !fs.existsSync(filePath)) {
      return res.status(404).json({ success: false, error: 'File laporan tidak ditemukan.' });
    }

    const stat = fs.statSync(filePath);
    const isInline = req.query.inline === 'true' || req.query.view === 'true';

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${isInline ? 'inline' : 'attachment'}; filename="${safeFileName}"`);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length');

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  } catch (err) {
    console.error('Error in downloadReportHandler:', err);
    return res.status(500).json({ success: false, error: 'Gagal mengunduh file laporan.' });
  }
}

/**
 * GET /api/reports/list
 * List all generated PDF reports
 */
async function listReportsHandler(req, res) {
  try {
    const candidateDirs = getCandidateReportDirs();
    const seen = new Set();
    const reports = [];

    for (const d of candidateDirs) {
      if (!fs.existsSync(d)) continue;
      const files = fs.readdirSync(d).filter(f => f.endsWith('.pdf'));
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const p = path.join(d, file);
        try {
          const stats = fs.statSync(p);
          reports.push({
            fileName: file,
            downloadUrl: `/api/reports/download/${encodeURIComponent(file)}`,
            sizeBytes: stats.size,
            createdAt: stats.birthtime || stats.mtime
          });
        } catch (_) { }
      }
    }

    // Newest first
    reports.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    return res.json({
      success: true,
      total: reports.length,
      reports
    });
  } catch (err) {
    console.error('Error in listReportsHandler:', err);
    return res.status(500).json({ success: false, error: 'Gagal membaca daftar laporan.' });
  }
}

/**
 * DELETE /api/reports/:filename
 * Hard delete PDF report from storage
 */
async function deleteReportHandler(req, res) {
  try {
    const rawFileName = req.params.filename;
    const safeFileName = path.basename(rawFileName);

    if (!safeFileName.endsWith('.pdf')) {
      return res.status(400).json({ success: false, error: 'Hanya file PDF yang dapat dihapus.' });
    }

    const candidateDirs = getCandidateReportDirs();
    let deletedCount = 0;

    for (const d of candidateDirs) {
      const targetPath = path.join(d, safeFileName);
      if (fs.existsSync(targetPath)) {
        try {
          fs.unlinkSync(targetPath);
          deletedCount++;
        } catch (unlinkErr) {
          console.error(`Gagal menghapus file ${targetPath}:`, unlinkErr.message);
        }
      }
    }

    if (deletedCount === 0) {
      return res.status(404).json({ success: false, error: 'File laporan tidak ditemukan.' });
    }

    console.log(`🗑️ [API Report] Berkas laporan ${safeFileName} berhasil dihapus permanen (${deletedCount} lokasi).`);

    return res.json({
      success: true,
      message: `Berkas laporan ${safeFileName} berhasil dihapus permanen.`,
      fileName: safeFileName
    });
  } catch (err) {
    console.error('Error in deleteReportHandler:', err);
    return res.status(500).json({ success: false, error: `Gagal menghapus file: ${err.message}` });
  }
}

module.exports = {
  generateReportHandler,
  downloadReportHandler,
  listReportsHandler,
  deleteReportHandler
};
