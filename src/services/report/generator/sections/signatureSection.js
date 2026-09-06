const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');
const { drawSectionHeader, drawRunningHeader, renderFileCell } = require('../pdfHelpers');

/**
 * Render Section 3: AUDIT SESI SIGNATURE & KETERSEDIAAN FILE MEDIA
 */
function renderSignatureSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;
  const serverName = reportData.metadata.serverName;

  if (doc.y + 85 > PDF_LAYOUT.maxContentY) {
    doc.addPage();
    drawRunningHeader(doc, 'AUDIT SESI SIGNATURE & MEDIA', serverName);
  } else {
    doc.moveDown(0.4);
  }

  drawSectionHeader(doc, 'AUDIT SESI SIGNATURE & KETERSEDIAAN FILE MEDIA', '3');

  const sig = reportData.signature;
  const sigCategories = sig.categories && sig.categories.length > 0
    ? sig.categories
    : [{ name: 'Signature', information: '', items: sig.items || [] }];
  const totalSigItems = sig.items ? sig.items.length : 0;

  doc.fontSize(7.5).font('Helvetica').fillColor(PDF_COLORS.slateGray).text(
    `Tabel Induk: experiences  •  Tabel Anak: detail_experience  •  ${sigCategories.length} Kategori Sesi  •  ${totalSigItems} Detail Item  •  Berkas: ${sig.totalFilesReady} Tersedia, ${sig.totalFilesMissing} Hilang (${sig.fileAvailabilityPct}% Lengkap)`,
    margin,
    doc.y
  );
  doc.moveDown(0.4);

  const sigNoW = 18;
  const sigColW1 = 120; // Detail Sesi (detail_experience)
  const sigColW2 = 62;  // Sound Scape
  const sigColW3 = 55;  // Sound Code
  const sigColW4 = 90;  // Audio (sounds/)
  const sigColW5 = 89;  // Lampu (sounds/)
  const sigColW6 = pageWidth - (sigNoW + sigColW1 + sigColW2 + sigColW3 + sigColW4 + sigColW5); // Video (89 pt)

  const drawSigTableHeader = () => {
    const sigTableY = doc.y;
    doc.rect(margin, sigTableY, pageWidth, 12).fill(PDF_COLORS.slateLight);
    doc.fillColor(PDF_COLORS.slateDark).fontSize(6.2).font('Helvetica-Bold');
    doc.text('No', margin + 2, sigTableY + 2.5, { width: sigNoW, align: 'center' });
    doc.text('Detail Sesi (detail_experience)', margin + 4 + sigNoW, sigTableY + 2.5, { width: sigColW1 });
    doc.text('Sound Scape', margin + 4 + sigNoW + sigColW1, sigTableY + 2.5, { width: sigColW2 });
    doc.text('Sound Code', margin + 4 + sigNoW + sigColW1 + sigColW2, sigTableY + 2.5, { width: sigColW3 });
    doc.text('Audio (sounds/)', margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3, sigTableY + 2.5, { width: sigColW4 });
    doc.text('Lampu (sounds/)', margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3 + sigColW4, sigTableY + 2.5, { width: sigColW5 });
    doc.text('Video (videos/)', margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3 + sigColW4 + sigColW5, sigTableY + 2.5, { width: sigColW6 });
    doc.y = sigTableY + 13;
  };

  let globalSigIdx = 0;
  sigCategories.forEach((cat) => {
    if (doc.y + 35 > PDF_LAYOUT.maxContentY) {
      doc.addPage();
      drawRunningHeader(doc, 'AUDIT SESI SIGNATURE (Lanjutan)', serverName);
    }

    // Draw Parent Category Banner
    const catY = doc.y;
    doc.rect(margin, catY, pageWidth, 13).fill('#eef2ff');
    doc.rect(margin, catY, 3, 13).fill(PDF_COLORS.primary);
    doc.fillColor(PDF_COLORS.primary).fontSize(6.8).font('Helvetica-Bold');
    const catTitle = `SESI INDUK (experience): ${cat.name}`;
    doc.text(catTitle, margin + 7, catY + 2.5, { continued: true });
    doc.fillColor(PDF_COLORS.slateGray).fontSize(6.2).font('Helvetica');
    const infoStr = cat.information ? `  —  ${cat.information}` : '';
    doc.text(`${infoStr}  •  (${cat.items.length} detail item)`);
    doc.y = catY + 14;

    drawSigTableHeader();

    cat.items.forEach((item) => {
      globalSigIdx++;
      if (doc.y + 12.5 > PDF_LAYOUT.maxContentY) {
        doc.addPage();
        drawRunningHeader(doc, 'AUDIT SESI SIGNATURE (Lanjutan)', serverName);
        drawSigTableHeader();
      }

      const rY = doc.y;
      if (globalSigIdx % 2 === 1) doc.rect(margin, rY, pageWidth, 11.5).fill('#f8fafc');

      // No
      doc.fillColor(PDF_COLORS.slateGray).fontSize(6.2).font('Helvetica');
      doc.text(String(globalSigIdx), margin + 2, rY + 2, { width: sigNoW, align: 'center' });

      // Name
      doc.fillColor(PDF_COLORS.slateDark).fontSize(6.2).font('Helvetica-Bold');
      doc.text(item.name, margin + 4 + sigNoW, rY + 2, { width: sigColW1 - 4, ellipsis: true });

      // Sound Scape
      doc.fillColor(PDF_COLORS.primary).fontSize(6.2).font('Helvetica-Bold');
      doc.text(item.soundScape ? String(item.soundScape) : '—', margin + 4 + sigNoW + sigColW1, rY + 2, { width: sigColW2 - 2 });

      // Sound Code
      doc.fillColor(PDF_COLORS.slateGray).fontSize(6).font('Helvetica');
      doc.text(item.soundCode ? String(item.soundCode) : '—', margin + 4 + sigNoW + sigColW1 + sigColW2, rY + 2, { width: sigColW3 - 2 });

      // Files
      renderFileCell(doc, item.song, margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3, sigColW4, rY, 17, 5.6);
      renderFileCell(doc, item.lamp, margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3 + sigColW4, sigColW5, rY, 17, 5.6);
      renderFileCell(doc, item.video, margin + 4 + sigNoW + sigColW1 + sigColW2 + sigColW3 + sigColW4 + sigColW5, sigColW6, rY, 17, 5.6);

      doc.y = rY + 12;
    });

    doc.y += 2.5; // Spacing between categories
  });

  doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica-Bold').text(
    `•  Status Berkas Fisik: ${sig.totalFilesReady} Berkas Tersedia [Hijau] | ${sig.totalFilesMissing} Berkas Hilang [Merah] dari total ${sig.totalFilesChecked} media fisik yang terdaftar.`,
    margin + 6,
    doc.y + 2
  );
  doc.y += 10;
}

module.exports = {
  renderSignatureSection
};
