const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');
const { drawSectionHeader, drawRunningHeader, renderFileCell } = require('../pdfHelpers');

/**
 * Render Section 4: AUDIT SESI EXPLORE & KETERSEDIAAN FILE MEDIA
 */
function renderExploreSection(doc, reportData) {
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;
  const serverName = reportData.metadata.serverName;

  const exp = reportData.explore;
  const expCategories = exp.categories && exp.categories.length > 0
    ? exp.categories
    : [{ name: 'Explore', description: '', items: exp.items || [] }];
  const totalExpItems = exp.items ? exp.items.length : 0;

  // Start Section 4 cleanly on a new page
  doc.addPage();
  drawRunningHeader(doc, 'AUDIT SESI EXPLORE & MEDIA', serverName);
  drawSectionHeader(doc, 'AUDIT SESI EXPLORE & KETERSEDIAAN FILE MEDIA', '4');

  doc.fontSize(7.5).font('Helvetica').fillColor(PDF_COLORS.slateGray).text(
    `Tabel Induk: self_development  •  Tabel Anak: self_development_sound  •  ${expCategories.length} Kategori Sesi  •  ${totalExpItems} Sound Item  •  Berkas: ${exp.totalFilesReady} Tersedia, ${exp.totalFilesMissing} Hilang (${exp.fileAvailabilityPct}% Lengkap)`,
    margin,
    doc.y
  );
  doc.moveDown(0.4);

  const expNoW = 16;
  const expColW1 = 110; // Detail Sound (self_development_sound)
  const expColW2 = 50;  // Sound Code
  const expColW3 = 50;  // Sound Scape
  const expColW4 = 76;  // Suara
  const expColW5 = 73;  // Lampu
  const expColW6 = 74;  // Video
  const expColW7 = pageWidth - (expNoW + expColW1 + expColW2 + expColW3 + expColW4 + expColW5 + expColW6); // Cover (74 pt)

  const drawExpTableHeader = () => {
    const expTableY = doc.y;
    doc.rect(margin, expTableY, pageWidth, 12).fill(PDF_COLORS.slateLight);
    doc.fillColor(PDF_COLORS.slateDark).fontSize(6.2).font('Helvetica-Bold');
    doc.text('No', margin + 2, expTableY + 2.5, { width: expNoW, align: 'center' });
    doc.text('Detail Sound (self_dev_sound)', margin + 4 + expNoW, expTableY + 2.5, { width: expColW1 });
    doc.text('Sound Code', margin + 4 + expNoW + expColW1, expTableY + 2.5, { width: expColW2 });
    doc.text('Sound Scape', margin + 4 + expNoW + expColW1 + expColW2, expTableY + 2.5, { width: expColW3 });
    doc.text('Suara (sounds/)', margin + 4 + expNoW + expColW1 + expColW2 + expColW3, expTableY + 2.5, { width: expColW4 });
    doc.text('Lampu (sounds/)', margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4, expTableY + 2.5, { width: expColW5 });
    doc.text('Video (videos/)', margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4 + expColW5, expTableY + 2.5, { width: expColW6 });
    doc.text('Cover (images/)', margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4 + expColW5 + expColW6, expTableY + 2.5, { width: expColW7 });
    doc.y = expTableY + 13;
  };

  let globalExpIdx = 0;
  expCategories.forEach((cat) => {
    if (doc.y + 35 > PDF_LAYOUT.maxContentY) {
      doc.addPage();
      drawRunningHeader(doc, 'AUDIT SESI EXPLORE (Lanjutan)', serverName);
    }

    // Draw Parent Category Banner
    const catY = doc.y;
    doc.rect(margin, catY, pageWidth, 13).fill('#f0f9ff');
    doc.rect(margin, catY, 3, 13).fill('#0284c7');
    doc.fillColor(PDF_COLORS.primary).fontSize(6.8).font('Helvetica-Bold');
    const catTitle = `KATEGORI INDUK (self_development): ${cat.name}`;
    doc.text(catTitle, margin + 7, catY + 2.5, { continued: true });
    doc.fillColor(PDF_COLORS.slateGray).fontSize(6.2).font('Helvetica');
    const descStr = cat.description ? `  —  ${cat.description}` : '';
    doc.text(`${descStr}  •  (${cat.items.length} sound item)`);
    doc.y = catY + 14;

    drawExpTableHeader();

    cat.items.forEach((item) => {
      globalExpIdx++;
      if (doc.y + 12.5 > PDF_LAYOUT.maxContentY) {
        doc.addPage();
        drawRunningHeader(doc, 'AUDIT SESI EXPLORE (Lanjutan)', serverName);
        drawExpTableHeader();
      }

      const rY = doc.y;
      if (globalExpIdx % 2 === 1) doc.rect(margin, rY, pageWidth, 11.5).fill('#f8fafc');

      // No
      doc.fillColor(PDF_COLORS.slateGray).fontSize(6.2).font('Helvetica');
      doc.text(String(globalExpIdx), margin + 2, rY + 2, { width: expNoW, align: 'center' });

      // Name
      doc.fillColor(PDF_COLORS.slateDark).fontSize(6.2).font('Helvetica-Bold');
      doc.text(item.name, margin + 4 + expNoW, rY + 2, { width: expColW1 - 4, ellipsis: true });

      // Sound Code
      doc.fillColor(PDF_COLORS.primary).fontSize(6.2).font('Helvetica-Bold');
      doc.text(item.soundCode ? String(item.soundCode) : '—', margin + 4 + expNoW + expColW1, rY + 2, { width: expColW2 - 2 });

      // Sound Scape
      doc.fillColor(PDF_COLORS.slateGray).fontSize(6).font('Helvetica');
      doc.text(item.soundScape ? String(item.soundScape) : '—', margin + 4 + expNoW + expColW1 + expColW2, rY + 2, { width: expColW3 - 2 });

      // Files
      renderFileCell(doc, item.sound, margin + 4 + expNoW + expColW1 + expColW2 + expColW3, expColW4, rY, 15, 5.4);
      renderFileCell(doc, item.lamp, margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4, expColW5, rY, 15, 5.4);
      renderFileCell(doc, item.video, margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4 + expColW5, expColW6, rY, 15, 5.4);
      renderFileCell(doc, item.coverAlbum, margin + 4 + expNoW + expColW1 + expColW2 + expColW3 + expColW4 + expColW5 + expColW6, expColW7, rY, 15, 5.4);

      doc.y = rY + 12;
    });

    doc.y += 2.5; // Spacing between categories
  });

  doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica-Bold').text(
    `•  Status Berkas Fisik: ${exp.totalFilesReady} Berkas Tersedia [Hijau] | ${exp.totalFilesMissing} Berkas Hilang [Merah] dari total ${exp.totalFilesChecked} media fisik yang terdaftar.`,
    margin + 6,
    doc.y + 2
  );
  doc.y += 10;
}

module.exports = {
  renderExploreSection
};
