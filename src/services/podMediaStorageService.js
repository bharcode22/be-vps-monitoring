/**
 * Pod Media Storage & AWS S3 Manager Service
 * Handles remote disk inspection, AWS S3 synchronization, media scanning, and Docker storage management
 */
const {
  executeCommand,
  getPodStorageSummary
} = require('./podStorage/podDiskService');

const {
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  detectPodRogueFiles,
  downloadS3FilesToPod,
  checkPodFileIntegrity
} = require('./podStorage/podMediaScannerService');

const {
  getMimeType,
  streamPodPhysicalFile
} = require('./podStorage/podMediaStreamService');

const {
  inspectPodDockerStorage,
  cleanPodDockerStorage
} = require('./podStorage/podDockerStorageService');

module.exports = {
  // Remote Disk & SSH execution
  executeCommand,
  getPodStorageSummary,

  // AWS S3 Media & Physical Code Scanner
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  detectPodRogueFiles,
  downloadS3FilesToPod,
  checkPodFileIntegrity,

  // Media Streaming & MIME Types
  getMimeType,
  streamPodPhysicalFile,

  // Docker Container Storage
  inspectPodDockerStorage,
  cleanPodDockerStorage
};
