const path = require('path');
const fs = require('fs');

// Resolve report storage directory with multi-path fallback
function getReportsDir() {
  const dir1 = path.resolve(__dirname, '../../../data/reports'); // backend/src/data/reports
  if (fs.existsSync(dir1)) return dir1;

  const dir2 = path.resolve(__dirname, '../../../../data/reports'); // backend/data/reports
  if (fs.existsSync(dir2)) return dir2;

  try {
    fs.mkdirSync(dir1, { recursive: true });
    return dir1;
  } catch (_) {
    return dir2;
  }
}

const REPORTS_DIR = getReportsDir();

const PDF_COLORS = {
  primary: '#0f172a',
  cyan: '#0284c7',
  emerald: '#10b981',
  red: '#ef4444',
  amber: '#f59e0b',
  slateDark: '#1e293b',
  slateGray: '#64748b',
  slateLight: '#f8fafc',
  borderLight: '#e2e8f0'
};

const PDF_LAYOUT = {
  margin: 36,
  pageWidth: 523.28, // 595.28 - 72
  pageHeight: 841.89,
  maxContentY: 795
};

module.exports = {
  REPORTS_DIR,
  getReportsDir,
  PDF_COLORS,
  PDF_LAYOUT
};
