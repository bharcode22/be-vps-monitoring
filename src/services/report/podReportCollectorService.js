/**
 * ============================================================================
 * POD REPORT COLLECTOR SERVICE (BACKWARD COMPATIBILITY FACADE)
 * ============================================================================
 * Modul ini telah direfaktor menjadi arsitektur modular di folder ./collector/.
 * File ini dipertahankan sebagai facade/re-exporter untuk menjamin 100%
 * kompatibilitas mundur dengan modul-modul lain yang mengimpor file ini secara langsung.
 */

const {
  collectFullPodReportData,
  resolvePodId,
  collectTopicsComparison,
  collectHourlyHeartbeatTelemetry,
  scanPodPhysicalFiles,
  auditSessionSignature,
  auditSessionExplore,
  resolvePodStorageDir,
  getPodStorageBaseDir,
  queryPodDb,
  getPodDbUrl
} = require('./collector');

module.exports = {
  collectFullPodReportData,
  resolvePodId,
  collectTopicsComparison,
  collectHourlyHeartbeatTelemetry,
  scanPodPhysicalFiles,
  auditSessionSignature,
  auditSessionExplore,
  resolvePodStorageDir,
  getPodStorageBaseDir,
  queryPodDb,
  getPodDbUrl
};
