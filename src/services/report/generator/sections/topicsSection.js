const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');
const { drawSectionHeader, drawBadge, drawRunningHeader } = require('../pdfHelpers');

/**
 * Render Section 2: AUDIT TOPIK MQTT & SOCKET (pod_topics & socket_topics)
 */
function renderTopicsSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;
  const serverName = reportData.metadata.serverName;

  doc.addPage();
  drawRunningHeader(doc, 'AUDIT TOPIK MQTT & SOCKET', serverName);

  drawSectionHeader(doc, 'AUDIT TOPIK MQTT & SOCKET (pod_topics & socket_topics)', '2');

  const topTopics = reportData.topics;
  doc.fontSize(7.5).font('Helvetica').fillColor(PDF_COLORS.slateGray).text(
    `pod_topics: ${topTopics.podTopics.matchedCount}/${topTopics.podTopics.totalMaster} Cocok   •   socket_topics: ${topTopics.socketTopics.matchedCount}/${topTopics.socketTopics.totalMaster} Cocok   •   Status: ${topTopics.overallSynced ? '100% SINKRON' : 'DITEMUKAN SELISIH'}`,
    margin,
    doc.y
  );
  doc.moveDown(0.4);

  const colW1 = 220; // Nama Topik (Spacious)
  const colW2 = 70;  // Tipe Tabel
  const colW3 = 70;  // Master DB
  const colW4 = 70;  // POD DB
  const colW5 = pageWidth - (colW1 + colW2 + colW3 + colW4); // Status (~93 pt)

  const drawTopicsTableHeader = () => {
    const topTableY = doc.y;
    doc.rect(margin, topTableY, pageWidth, 13).fill(PDF_COLORS.slateLight);
    doc.fillColor(PDF_COLORS.slateDark).fontSize(6.5).font('Helvetica-Bold');
    doc.text('Nama Topik', margin + 6, topTableY + 3, { width: colW1 });
    doc.text('Tipe Tabel', margin + 6 + colW1, topTableY + 3, { width: colW2 });
    doc.text('Master DB', margin + 6 + colW1 + colW2, topTableY + 3, { width: colW3 });
    doc.text('POD DB', margin + 6 + colW1 + colW2 + colW3, topTableY + 3, { width: colW4 });
    doc.text('Status', margin + 6 + colW1 + colW2 + colW3 + colW4, topTableY + 3, { width: colW5 });
    doc.y = topTableY + 14;
  };

  drawTopicsTableHeader();

  const sampleTopics = [
    ...topTopics.podTopics.rows.map(r => ({ ...r, type: 'pod_topics' })),
    ...topTopics.socketTopics.rows.map(r => ({ ...r, type: 'socket_topics' }))
  ];

  // Priority: Discrepancies first, then alphabetical by topic name
  sampleTopics.sort((a, b) => {
    if (a.status !== 'MATCH' && b.status === 'MATCH') return -1;
    if (a.status === 'MATCH' && b.status !== 'MATCH') return 1;
    return String(a.topic).localeCompare(String(b.topic));
  });

  sampleTopics.forEach((t, i) => {
    if (doc.y + 12 > PDF_LAYOUT.maxContentY) {
      doc.addPage();
      drawRunningHeader(doc, 'AUDIT TOPIK MQTT & SOCKET (Lanjutan)', serverName);
      drawTopicsTableHeader();
    }

    const rY = doc.y;
    if (i % 2 === 1) doc.rect(margin, rY, pageWidth, 11).fill('#f8fafc');

    doc.fillColor(PDF_COLORS.primary).fontSize(6.5).font('Helvetica');
    doc.text(t.topic, margin + 6, rY + 2, { width: colW1 - 4, ellipsis: true });
    doc.text(t.type, margin + 6 + colW1, rY + 2, { width: colW2 });

    const masterText = t.inMaster ? '[Ada] Master' : '[—] Kosong';
    const podText = t.inPod ? '[Ada] POD' : '[—] Kosong';
    doc.fillColor(t.inMaster ? '#15803d' : '#b91c1c').text(masterText, margin + 6 + colW1 + colW2, rY + 2, { width: colW3 });
    doc.fillColor(t.inPod ? '#15803d' : '#b91c1c').text(podText, margin + 6 + colW1 + colW2 + colW3, rY + 2, { width: colW4 });

    drawBadge(doc, margin + 6 + colW1 + colW2 + colW3 + colW4, rY + 1, t.status, t.status === 'MATCH' ? 'SUCCESS' : 'DANGER');
    doc.y = rY + 11.5;
  });

  doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica-Bold').text(
    `•  Seluruh ${sampleTopics.length} topik terdaftar ditampilkan (${sampleTopics.filter(t => t.status === 'MATCH').length} cocok, ${sampleTopics.filter(t => t.status !== 'MATCH').length} selisih)`,
    margin + 6,
    doc.y + 3
  );
  doc.y += 12;
}

module.exports = {
  renderTopicsSection
};
