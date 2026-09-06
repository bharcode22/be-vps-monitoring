const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');

/**
 * Render Header Banner & Health Score Card
 */
function renderHeaderSection(doc, reportData) {
  const metadata = reportData.metadata;
  const bannerY = PDF_LAYOUT.margin;
  const bannerH = 76;
  const pageWidth = PDF_LAYOUT.pageWidth;

  doc.rect(PDF_LAYOUT.margin, bannerY, pageWidth, bannerH).fill(PDF_COLORS.primary);

  // Left Content Container (Strictly bounded: width = 350 pt)
  const leftContentX = 48;
  const leftContentW = 350;

  const wibDate = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WIB';

  doc.fillColor('#38bdf8').fontSize(7.5).font('Helvetica-Bold').text(
    'REGENESIS FLEET SYSTEM — DIAGNOSTIC & AUDIT REPORT',
    leftContentX,
    bannerY + 10,
    { width: leftContentW }
  );
  doc.fillColor('#ffffff').fontSize(17).font('Helvetica-Bold').text(
    metadata.serverName,
    leftContentX,
    bannerY + 22,
    { width: leftContentW }
  );

  doc.fillColor('#94a3b8').fontSize(8).font('Helvetica').text(
    `Host IP: ${metadata.serverHost}   •   Waktu Audit: ${wibDate}`,
    leftContentX,
    bannerY + 44,
    { width: leftContentW }
  );

  const uuidDisplay = metadata.podUuid || metadata.resolvedPodId || metadata.serverCode || 'N/A';
  doc.fillColor('#64748b').fontSize(7.5).font('Helvetica').text(
    `Pod UUID: ${uuidDisplay}`,
    leftContentX,
    bannerY + 58,
    { width: leftContentW, ellipsis: true }
  );

  // Right Health Score Container (Anchored at right margin, strictly separated)
  const scoreCardW = 100;
  const scoreCardH = 58;
  const scoreCardX = PDF_LAYOUT.margin + pageWidth - scoreCardW - 12;
  const scoreCardY = bannerY + 9;

  const healthScore = reportData.scores.overallHealthScore;
  const scoreBgColor = healthScore >= 85
    ? PDF_COLORS.emerald
    : (healthScore >= 60 ? PDF_COLORS.amber : PDF_COLORS.red);
  const scoreLabel = healthScore >= 85 ? 'HEALTHY' : (healthScore >= 60 ? 'WARNING' : 'CRITICAL');

  doc.roundedRect(scoreCardX, scoreCardY, scoreCardW, scoreCardH, 4).fill(scoreBgColor);
  doc.fillColor('#ffffff').fontSize(7.5).font('Helvetica-Bold').text('HEALTH SCORE', scoreCardX, scoreCardY + 6, { width: scoreCardW, align: 'center' });
  doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold').text(`${healthScore}%`, scoreCardX, scoreCardY + 18, { width: scoreCardW, align: 'center' });

  doc.roundedRect(scoreCardX + 16, scoreCardY + 42, scoreCardW - 32, 11, 2).fill('rgba(0,0,0,0.25)');
  doc.fillColor('#ffffff').fontSize(6.5).font('Helvetica-Bold').text(scoreLabel, scoreCardX + 16, scoreCardY + 44, { width: scoreCardW - 32, align: 'center' });

  doc.y = bannerY + bannerH + 12;
}

module.exports = {
  renderHeaderSection
};
