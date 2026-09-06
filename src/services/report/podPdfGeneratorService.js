/**
 * ============================================================================
 * POD PDF GENERATOR SERVICE (BACKWARD COMPATIBILITY FACADE)
 * ============================================================================
 * Modul ini telah direfaktor menjadi arsitektur modular di folder ./generator/.
 * File ini dipertahankan sebagai facade/re-exporter untuk menjamin 100%
 * kompatibilitas mundur dengan modul-modul lain yang mengimpor file ini secara langsung.
 */

const {
  generatePodPdfReport,
  REPORTS_DIR
} = require('./generator');

module.exports = {
  generatePodPdfReport,
  REPORTS_DIR
};
