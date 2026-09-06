const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { REPORTS_DIR } = require('./pdfConstants');
const { ensureReportsDir } = require('./pdfHelpers');
const { renderHeaderSection } = require('./sections/headerSection');
const { renderKpiSection } = require('./sections/kpiSection');
const { renderHeartbeatSection } = require('./sections/heartbeatSection');
const { renderTopicsSection } = require('./sections/topicsSection');
const { renderSignatureSection } = require('./sections/signatureSection');
const { renderExploreSection } = require('./sections/exploreSection');
const { renderRecommendationsSection } = require('./sections/recommendationsSection');
const { renderFooterSection } = require('./sections/footerSection');

/**
 * Generate PDF Report from collected data object
 * @param {Object} reportData - Result from collectFullPodReportData
 * @returns {Promise<{ filePath: string, fileName: string, fileSizeBytes: number }>}
 */
async function generatePodPdfReport(reportData) {
  ensureReportsDir();

  const metadata = reportData.metadata;
  const sanitizedName = String(metadata.serverName || `POD_${metadata.serverId}`)
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '_');

  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
  const fileName = `report_${sanitizedName}_${dateStr}_${timeStr}.pdf`;
  const filePath = path.join(REPORTS_DIR, fileName);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
      autoFirstPage: true,
      bufferPages: true
    });

    const writeStream = fs.createWriteStream(filePath);
    doc.pipe(writeStream);

    try {
      // 1. Cover & Score Card
      renderHeaderSection(doc, reportData);

      // 2. Executive 4 KPI Cards
      renderKpiSection(doc, reportData);

      // 3. Section 1: Heartbeat Telemetry & Strip Chart
      renderHeartbeatSection(doc, reportData);

      // 4. Section 2: MQTT & Socket Topics Matrix
      renderTopicsSection(doc, reportData);

      // 5. Section 3: Signature Sessions Audit
      renderSignatureSection(doc, reportData);

      // 6. Section 4: Explore Sessions Audit
      renderExploreSection(doc, reportData);

      // 7. Section 5: Recommendations & Action Items
      renderRecommendationsSection(doc, reportData);

      // 8. Footers across all buffered pages
      renderFooterSection(doc);

      // Finalize PDF Document
      doc.end();
    } catch (renderErr) {
      writeStream.destroy();
      return reject(renderErr);
    }

    writeStream.on('finish', () => {
      try {
        const stats = fs.statSync(filePath);
        resolve({
          filePath,
          fileName,
          fileSizeBytes: stats.size
        });
      } catch (err) {
        resolve({ filePath, fileName, fileSizeBytes: 0 });
      }
    });

    writeStream.on('error', (err) => {
      reject(err);
    });
  });
}

module.exports = {
  generatePodPdfReport,
  REPORTS_DIR
};
