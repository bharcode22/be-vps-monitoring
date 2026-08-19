/**
 * Modular Installation Service Interface
 * Re-exports from modular installation services in ./installation/
 */
const installation = require('./installation');

module.exports = {
  // MinIO S3 Version Services
  getInstallationVersions: installation.getInstallationVersions,
  sortVersionsByNewest: installation.sortVersionsByNewest,
  resolveMinioAppPath: installation.resolveMinioAppPath,

  // Environment File Configuration Services
  getEnvFiles: installation.getEnvFiles,
  readEnvFileContent: installation.readEnvFileContent,

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
