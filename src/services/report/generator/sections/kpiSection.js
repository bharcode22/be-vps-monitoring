const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');

/**
 * Render Executive KPI Summary Cards
 */
function renderKpiSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const cardWidth = (pageWidth - 18) / 4;
  const cardY = doc.y;
  const cardHeight = 48;

  const cards = [
    {
      title: 'TOPICS SYNC',
      val: `${reportData.topics.podTopics.matchedCount}/${reportData.topics.podTopics.totalMaster}`,
      sub: reportData.topics.overallSynced ? '100% Match' : `${reportData.topics.podTopics.missingInPodCount} Belum Sinkron`,
      color: reportData.topics.overallSynced ? PDF_COLORS.emerald : PDF_COLORS.amber
    },
    {
      title: 'HEARTBEAT 1 JAM',
      val: `${reportData.heartbeat.averageUptimePct}%`,
      sub: `${reportData.heartbeat.liveModulesCount}/${reportData.heartbeat.totalModulesTracked} Modul Online`,
      color: reportData.heartbeat.averageUptimePct >= 80 ? PDF_COLORS.emerald : (reportData.heartbeat.averageUptimePct > 0 ? PDF_COLORS.amber : PDF_COLORS.red)
    },
    {
      title: 'SESI SIGNATURE',
      val: `${reportData.signature.fileAvailabilityPct}% Ready`,
      sub: `${reportData.signature.totalFilesReady} Tersedia • ${reportData.signature.totalFilesMissing} Hilang`,
      color: reportData.signature.fileAvailabilityPct === 100 ? PDF_COLORS.emerald : (reportData.signature.fileAvailabilityPct > 0 ? PDF_COLORS.amber : PDF_COLORS.red)
    },
    {
      title: 'SESI EXPLORE',
      val: `${reportData.explore.fileAvailabilityPct}% Ready`,
      sub: `${reportData.explore.totalFilesReady} Tersedia • ${reportData.explore.totalFilesMissing} Hilang`,
      color: reportData.explore.fileAvailabilityPct === 100 ? PDF_COLORS.emerald : (reportData.explore.fileAvailabilityPct > 0 ? PDF_COLORS.amber : PDF_COLORS.red)
    }
  ];

  cards.forEach((c, idx) => {
    const cx = PDF_LAYOUT.margin + idx * (cardWidth + 6);
    doc.roundedRect(cx, cardY, cardWidth, cardHeight, 3).fillAndStroke(PDF_COLORS.slateLight, PDF_COLORS.borderLight);
    doc.rect(cx, cardY, 3, cardHeight).fill(c.color);

    doc.fillColor(PDF_COLORS.slateGray).fontSize(7).font('Helvetica-Bold').text(c.title, cx + 10, cardY + 7);
    doc.fillColor(PDF_COLORS.primary).fontSize(13).font('Helvetica-Bold').text(c.val, cx + 10, cardY + 18);
    doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica').text(c.sub, cx + 10, cardY + 33);
  });

  doc.y = cardY + cardHeight + 10;
}

module.exports = {
  renderKpiSection
};
