/**
 * Modular Installation Service Interface
 * Re-exports from modular installation services in ./installation/
 */
const installation = require('./installation');

module.exports = {
  // MinIO S3 Version & Artifact Services
  getInstallationVersions: installation.getInstallationVersions,
  getDetailedArtifactVersions: installation.getDetailedArtifactVersions,
  deleteArtifactVersion: installation.deleteArtifactVersion,
  deleteBatchArtifactVersions: installation.deleteBatchArtifactVersions,
  cleanupOldArtifactVersions: installation.cleanupOldArtifactVersions,
  sortVersionsByNewest: installation.sortVersionsByNewest,
  resolveMinioAppPath: installation.resolveMinioAppPath,

  // Environment File Configuration & Manager Services
  getEnvFiles: installation.getEnvFiles,
  readEnvFileContent: installation.readEnvFileContent,
  parseEnvContent: installation.parseEnvContent,
  serializeEnvKv: installation.serializeEnvKv,
  createEnvFile: installation.createEnvFile,
  saveEnvFile: installation.saveEnvFile,
  deleteEnvFile: installation.deleteEnvFile,
  compareEnvFiles: installation.compareEnvFiles,

  // SSH Execution Services
  executeSSHCommand: installation.executeSSHCommand,
  executeSSHCommandStream: installation.executeSSHCommandStream,

  // Deployment Script Generator Services
  generateMinioClientResolutionSnippet: installation.generateMinioClientResolutionSnippet,
  generateBatchDownloadScript: installation.generateBatchDownloadScript,
  generateDebDeploymentSnippet: installation.generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet: installation.generateDockerDeploymentSnippet,

  // Deployment Runners
  deployPodApp: installation.deployPodApp,
  deployBatchPodAppServerStream: installation.deployBatchPodAppServerStream
};
