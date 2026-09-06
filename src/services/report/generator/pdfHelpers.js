const fs = require('fs');
const { REPORTS_DIR, PDF_COLORS, PDF_LAYOUT } = require('./pdfConstants');

function ensureReportsDir() {
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
}

/**
 * Draw Section Header with Clean Numbered Indicator (No Emojis)
 */
function drawSectionHeader(doc, title, numberStr = '1') {
  doc.moveDown(0.6);
  const y = doc.y;
  doc.roundedRect(PDF_LAYOUT.margin, y, 16, 16, 3).fill(PDF_COLORS.cyan);
  doc.fillColor('#ffffff').fontSize(8.5).font('Helvetica-Bold').text(numberStr, PDF_LAYOUT.margin, y + 3.5, { width: 16, align: 'center' });
  doc.fontSize(10.5).font('Helvetica-Bold').fillColor(PDF_COLORS.primary);
  doc.text(title, PDF_LAYOUT.margin + 22, y + 2.5);
  doc.moveDown(0.5);
}

/**
 * Draw Status Badge with tailored background and text color
 */
function drawBadge(doc, x, y, text, type = 'SUCCESS') {
  let bg = '#dcfce7';
  let fg = '#15803d';
  if (type === 'DANGER' || type === 'DEAD' || type === 'MISSING' || type === 'OFFLINE') {
    bg = '#fee2e2';
    fg = '#b91c1c';
  } else if (type === 'WARNING' || type === 'DELAY' || type === 'EXTRA' || type === 'DEGRADED') {
    bg = '#fef3c7';
    fg = '#b45309';
  } else if (type === 'NEUTRAL' || type === 'NO_DATA') {
    bg = '#f1f5f9';
    fg = '#475569';
  }

  const badgeWidth = Math.max(text.length * 5.5 + 10, 42);
  doc.roundedRect(x, y, badgeWidth, 13, 2).fill(bg);
  doc.fontSize(7).font('Helvetica-Bold').fillColor(fg);
  doc.text(text, x, y + 3, { width: badgeWidth, align: 'center' });
  return badgeWidth;
}

/**
 * Draw Running Header on continuation pages
 */
function drawRunningHeader(doc, sectionTitle, serverName) {
  const subHeaderY = PDF_LAYOUT.margin;
  doc.fillColor(PDF_COLORS.slateGray).fontSize(7).font('Helvetica-Bold').text(
    `REGENESIS FLEET  •  ${serverName}  •  ${sectionTitle.toUpperCase()}`,
    PDF_LAYOUT.margin,
    subHeaderY
  );
  doc.rect(PDF_LAYOUT.margin, subHeaderY + 11, PDF_LAYOUT.pageWidth, 0.5).fill(PDF_COLORS.borderLight);
  doc.y = subHeaderY + 18;
}

/**
 * Render physical media file cell with [Tersedia] or [Hilang] status
 */
function renderFileCell(doc, fObj, x, w, rY, maxLen = 17, fontSize = 5.6) {
  const rawName = fObj ? fObj.name : null;
  if (!rawName || rawName === '0' || rawName === 'null' || String(rawName).trim() === '') {
    doc.fillColor(PDF_COLORS.slateGray).fontSize(6).font('Helvetica').text('—', x, rY + 2.5);
    return;
  }
  const tag = fObj.exists ? '[Tersedia]' : '[Hilang]';
  const fg = fObj.exists ? '#15803d' : '#b91c1c';
  const cleanName = rawName.length > maxLen ? rawName.slice(0, maxLen - 2) + '...' : rawName;
  doc.fillColor(fg).fontSize(fontSize).font('Helvetica').text(
    `${tag} ${cleanName}`,
    x,
    rY + 2.5,
    { width: w - 2, lineBreak: false }
  );
}

module.exports = {
  ensureReportsDir,
  drawSectionHeader,
  drawBadge,
  drawRunningHeader,
  renderFileCell
};
