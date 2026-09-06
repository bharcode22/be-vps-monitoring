const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');
const { drawSectionHeader, drawRunningHeader } = require('../pdfHelpers');

/**
 * Render Section 5: KESIMPULAN AUDIT & TINDAKAN YANG DIREKOMENDASIKAN
 */
function renderRecommendationsSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;
  const serverName = reportData.metadata.serverName;

  if (doc.y + 120 > PDF_LAYOUT.maxContentY) {
    doc.addPage();
    drawRunningHeader(doc, 'KESIMPULAN AUDIT & REKOMENDASI', serverName);
  } else {
    doc.moveDown(0.6);
  }

  drawSectionHeader(doc, 'KESIMPULAN AUDIT & TINDAKAN YANG DIREKOMENDASIKAN', '5');

  const actionBoxY = doc.y;
  const actionBoxH = 96;

  doc.roundedRect(margin, actionBoxY, pageWidth, actionBoxH, 4).fillAndStroke(PDF_COLORS.slateLight, PDF_COLORS.borderLight);
  doc.fillColor(PDF_COLORS.primary).fontSize(7.5).font('Helvetica-Bold').text('RINGKASAN STATUS KESEHATAN SISTEM:', margin + 12, actionBoxY + 8);

  const topTopics = reportData.topics;
  const hb = reportData.heartbeat;
  const sig = reportData.signature;
  const exp = reportData.explore;

  const bulletItems = [];
  if (topTopics.overallSynced) {
    bulletItems.push('Semua topik MQTT (pod_topics & socket_topics) 100% sinkron antara Master DB dan database lokal POD.');
  } else {
    bulletItems.push(`Terdapat ${topTopics.podTopics.missingInPodCount} topik pod_topics dan ${topTopics.socketTopics.missingInPodCount} socket_topics yang belum tersinkronisasi ke POD DB.`);
  }

  if (hb.averageUptimePct >= 80) {
    bulletItems.push(`Telemetri detak modul 1 jam terakhir sangat stabil (${hb.averageUptimePct}% uptime, ${hb.liveModulesCount}/${hb.totalModulesTracked} modul online).`);
  } else {
    const deadCount = (hb.modules || []).filter(m => !m.isLive).length;
    bulletItems.push(`Uptime detak modul tercatat ${hb.averageUptimePct}%. Terdapat ${deadCount} modul offline/tidak mengirim detak (cek kabel USB/koneksi serial).`);
  }

  if (sig.fileAvailabilityPct === 100 && exp.fileAvailabilityPct === 100) {
    bulletItems.push('Seluruh file media fisik sesi Signature dan Explore telah lengkap dan terverifikasi di penyimpanan POD.');
  } else {
    const missingTotal = (sig.totalFilesMissing || 0) + (exp.totalFilesMissing || 0);
    bulletItems.push(`Terdeteksi ${missingTotal} file media fisik yang belum tersedia di direktori POD (/home/pod/sounds, videos, atau images). Diperlukan sinkronisasi media.`);
  }

  bulletItems.forEach((bText, bIdx) => {
    const bY = actionBoxY + 22 + (bIdx * 14);
    doc.fillColor(PDF_COLORS.slateDark).fontSize(7).font('Helvetica').text(`•  ${bText}`, margin + 16, bY, { width: pageWidth - 32 });
  });

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

  doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica-Oblique').text(
    `Laporan ini digenerate secara otomatis oleh Regenesis Fleet Monitoring pada ${wibDate}. Validasi berkas fisik dilakukan secara live via SSH probe.`,
    margin + 12,
    actionBoxY + 74,
    { width: pageWidth - 24 }
  );
}

module.exports = {
  renderRecommendationsSection
};
