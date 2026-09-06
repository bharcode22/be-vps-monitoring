const { PDF_COLORS, PDF_LAYOUT } = require('../pdfConstants');

/**
 * Render Dynamic Footers with "Halaman X dari Y" across all buffered pages
 */
function renderFooterSection(doc) {
  const range = doc.bufferedPageRange();
  const pageWidth = PDF_LAYOUT.pageWidth;
  const margin = PDF_LAYOUT.margin;

  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);

    // Disable bottom margin auto-page-break while drawing footers
    const oldMargin = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    const footerY = doc.page.height - 24;
    doc.rect(margin, footerY - 4, pageWidth, 0.5).fill(PDF_COLORS.borderLight);
    doc.fillColor(PDF_COLORS.slateGray).fontSize(6.5).font('Helvetica');
    doc.text(
      'Regenesis POD Fleet Monitoring Platform  •  Dokumen Resmi Diagnostik Otomatis',
      margin,
      footerY,
      { width: 350, lineBreak: false }
    );
    doc.text(
      `Halaman ${i + 1} dari ${range.count}`,
      margin + pageWidth - 100,
      footerY,
      { width: 100, align: 'right', lineBreak: false }
    );

    doc.page.margins.bottom = oldMargin;
  }
}

module.exports = {
  renderFooterSection
};
