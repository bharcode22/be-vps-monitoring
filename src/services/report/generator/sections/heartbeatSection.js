const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');
const { drawSectionHeader, drawBadge } = require('../pdfHelpers');

/**
 * Render Section 1: TELEMETRI DETAK HEARTBEAT (1 JAM TERAKHIR)
 */
function renderHeartbeatSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;

  drawSectionHeader(doc, 'TELEMETRI DETAK HEARTBEAT (1 JAM TERAKHIR)', '1');

  const hb = reportData.heartbeat;
  const storageText = hb.storageLocation ? `Lokasi: backend/src/data/pod_storage/${hb.storageLocation}` : 'Lokasi: pod_storage/pods';
  const stateText = hb.stateSnapshot ? `  •  Status: ${hb.stateSnapshot.stateText || 'VACANT'}` : '';
  const packetsText = `  •  Total Detak: ${(hb.totalPacketsLastHour || 0).toLocaleString()} paket`;
  const onlineText = `  •  Live: ${hb.liveModulesCount || 0}/${hb.totalModulesTracked || 0} Modul`;

  doc.fontSize(7.5).font('Helvetica').fillColor(PDF_COLORS.slateGray).text(
    `${storageText}${stateText}${packetsText}${onlineText}`,
    margin,
    doc.y,
    { width: pageWidth }
  );
  doc.moveDown(0.4);

  // Legend
  const legendY = doc.y;
  const drawLegendItem = (x, color, label) => {
    doc.rect(x, legendY, 7, 7).fill(color);
    doc.fillColor(PDF_COLORS.slateDark).fontSize(6.5).font('Helvetica').text(label, x + 11, legendY);
    return x + 11 + label.length * 4.2 + 12;
  };
  let legX = margin;
  legX = drawLegendItem(legX, PDF_COLORS.emerald, 'Normal (Healthy)');
  legX = drawLegendItem(legX, PDF_COLORS.amber, 'Delay / Gap (2-30s)');
  legX = drawLegendItem(legX, PDF_COLORS.red, 'Dead / Offline (>30s)');
  drawLegendItem(legX, '#cbd5e1', 'Tidak Ada Data');
  doc.y = legendY + 12;

  // Vector Strip Chart
  const modules = (hb.modules || []).slice(0, 10);
  const stripStartX = 185;
  const stripWidth = 265;
  const blockWidth = (stripWidth - 22) / 12;

  modules.forEach((mod) => {
    const rowY = doc.y;

    doc.fillColor(PDF_COLORS.primary).fontSize(7).font('Helvetica-Bold');
    doc.text(`[${mod.moduleId}] ${mod.moduleName}`, margin, rowY + 1, { width: 145, ellipsis: true });

    (mod.buckets || []).forEach((b, bIdx) => {
      const bx = stripStartX + bIdx * (blockWidth + 2);
      let bColor = PDF_COLORS.emerald;
      if (b.status === 'DEAD') bColor = PDF_COLORS.red;
      else if (b.status === 'DELAY') bColor = PDF_COLORS.amber;
      else if (b.status === 'NO_DATA') bColor = '#cbd5e1';

      doc.roundedRect(bx, rowY, blockWidth, 8, 1.5).fill(bColor);
    });

    const upColor = mod.uptimePct >= 80 ? PDF_COLORS.emerald : (mod.uptimePct > 0 ? PDF_COLORS.amber : PDF_COLORS.red);
    doc.fillColor(upColor).fontSize(7).font('Helvetica-Bold').text(
      `${mod.uptimePct}% (${(mod.totalPackets1h || 0).toLocaleString()} pkt)`,
      stripStartX + stripWidth + 6,
      rowY + 1,
      { width: 90, align: 'right' }
    );

    doc.y = rowY + 11;
  });

  // Time Axis
  const axisY = doc.y + 1;
  doc.fillColor(PDF_COLORS.slateGray).fontSize(6).font('Helvetica');
  doc.text('-60 mnt', stripStartX, axisY);
  doc.text('-45 mnt', stripStartX + (stripWidth * 0.25) - 8, axisY);
  doc.text('-30 mnt', stripStartX + (stripWidth * 0.5) - 8, axisY);
  doc.text('-15 mnt', stripStartX + (stripWidth * 0.75) - 8, axisY);
  doc.text('Sekarang', stripStartX + stripWidth - 26, axisY);
  doc.y = axisY + 12;

  // Telemetry Table
  const hbTableY = doc.y;
  const hbColW1 = 145; // Modul
  const hbColW2 = 60;  // Port
  const hbColW3 = 70;  // Status
  const hbColW4 = 80;  // Last HB
  const hbColW5 = 80;  // Total Packets
  const hbColW6 = pageWidth - (hbColW1 + hbColW2 + hbColW3 + hbColW4 + hbColW5); // Uptime

  doc.rect(margin, hbTableY, pageWidth, 13).fill(PDF_COLORS.slateLight);
  doc.fillColor(PDF_COLORS.slateDark).fontSize(6.5).font('Helvetica-Bold');
  doc.text('Modul Perangkat', margin + 6, hbTableY + 3, { width: hbColW1 });
  doc.text('Port Serial', margin + 6 + hbColW1, hbTableY + 3, { width: hbColW2 });
  doc.text('Status', margin + 6 + hbColW1 + hbColW2, hbTableY + 3, { width: hbColW3 });
  doc.text('Detak Terakhir', margin + 6 + hbColW1 + hbColW2 + hbColW3, hbTableY + 3, { width: hbColW4 });
  doc.text('Detak (1 Jam)', margin + 6 + hbColW1 + hbColW2 + hbColW3 + hbColW4, hbTableY + 3, { width: hbColW5 });
  doc.text('Uptime (1 Jam)', margin + 6 + hbColW1 + hbColW2 + hbColW3 + hbColW4 + hbColW5, hbTableY + 3, { width: hbColW6 });

  doc.y = hbTableY + 14;

  modules.forEach((mod, idx) => {
    const rY = doc.y;
    if (idx % 2 === 1) doc.rect(margin, rY, pageWidth, 11).fill('#f8fafc');

    doc.fillColor(PDF_COLORS.primary).fontSize(6.5).font('Helvetica');
    doc.text(`[${mod.moduleId}] ${mod.moduleName}`, margin + 6, rY + 2, { width: hbColW1, ellipsis: true });
    doc.text(mod.port || '—', margin + 6 + hbColW1, rY + 2, { width: hbColW2 });

    let badgeType = 'SUCCESS';
    if (mod.status === 'DEAD' || mod.status === 'OFFLINE') badgeType = 'DANGER';
    else if (mod.status === 'DEGRADED' || mod.status === 'DELAY' || mod.status === 'INACTIVE_1H') badgeType = 'WARNING';
    else if (mod.status === 'NO_DATA') badgeType = 'NEUTRAL';

    drawBadge(doc, margin + 6 + hbColW1 + hbColW2, rY + 1, mod.status, badgeType);

    const hbText = mod.latestHb !== null ? `#${mod.latestHb.toLocaleString()}` : '—';
    doc.text(hbText, margin + 6 + hbColW1 + hbColW2 + hbColW3, rY + 2, { width: hbColW4 });

    const pktText = `${(mod.totalPackets1h || 0).toLocaleString()} pkt`;
    doc.text(pktText, margin + 6 + hbColW1 + hbColW2 + hbColW3 + hbColW4, rY + 2, { width: hbColW5 });

    const upc = mod.uptimePct >= 80 ? PDF_COLORS.emerald : (mod.uptimePct > 0 ? PDF_COLORS.amber : PDF_COLORS.red);
    doc.fillColor(upc).font('Helvetica-Bold').text(
      `${mod.uptimePct}%`,
      margin + 6 + hbColW1 + hbColW2 + hbColW3 + hbColW4 + hbColW5,
      rY + 2,
      { width: hbColW6 }
    );

    doc.y = rY + 12;
  });

  doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica-Oblique').text(
    `* Seluruh data detak modul diekstraksi langsung dari berkas penyimpanan log fisik pod (${hb.storageLocation || 'pod_storage/pods'}) dalam rentang 60 menit terakhir.`,
    margin,
    doc.y + 4,
    { width: pageWidth }
  );
  doc.y += 12;
}

module.exports = {
  renderHeartbeatSection
};
