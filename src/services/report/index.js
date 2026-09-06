const {
  collectFullPodReportData,
  resolvePodId,
  collectTopicsComparison,
  collectHourlyHeartbeatTelemetry,
  scanPodPhysicalFiles,
  auditSessionSignature,
  auditSessionExplore,
  resolvePodStorageDir
} = require('./collector');

const {
  generatePodPdfReport,
  REPORTS_DIR
} = require('./generator');

module.exports = {
  // Main APIs
  collectFullPodReportData,
  generatePodPdfReport,
  REPORTS_DIR,

  // Modular Collectors
  resolvePodId,
  collectTopicsComparison,
  collectHourlyHeartbeatTelemetry,
  scanPodPhysicalFiles,
  auditSessionSignature,
  auditSessionExplore,
  resolvePodStorageDir
};
