/**
 * POD Storage Service (Facade / Aggregator)
 * 
 * Modularized into domain services under ./podStorage/:
 * - podDiskService: Disk partition breakdown (df -h) & media folder sizes
 * - podMediaScannerService: Physical media file scanning, junk & rogue detection, code folder file cleanup
 * - podMediaStreamService: SFTP/SSH media file streaming with HTTP 206 Range support
 * - podDockerStorageService: Docker disk usage inspection & BuildKit cache/prune cleanup
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
  executeCommand,
  getPodStorageSummary,
  scanPodPhysicalFiles,
  detectPodJunkFiles,
  cleanupPodJunkFiles,
  checkCodeFilesOnSinglePod,
  hardDeletePodCodeFiles,
  getMimeType,
  streamPodPhysicalFile,
  inspectPodDockerStorage,
  cleanPodDockerStorage,
  detectPodRogueFiles,
  downloadS3FilesToPod,
  checkPodFileIntegrity
};
