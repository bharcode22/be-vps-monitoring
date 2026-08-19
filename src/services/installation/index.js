const {
  getInstallationVersions,
  getDetailedArtifactVersions,
  deleteArtifactVersion,
  deleteBatchArtifactVersions,
  cleanupOldArtifactVersions,
  sortVersionsByNewest,
  resolveMinioAppPath
} = require('./minioService');

const {
  getEnvFiles,
  readEnvFileContent,
  parseEnvContent,
  serializeEnvKv,
  createEnvFile,
  saveEnvFile,
  deleteEnvFile,
  compareEnvFiles
} = require('./envService');

const { executeSSHCommand, executeSSHCommandStream } = require('./sshExecutor');

const {
  generateMinioClientResolutionSnippet,
  generateBatchDownloadScript,
  generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet
} = require('./scriptGenerators');

const { deployPodApp, deployBatchPodAppServerStream } = require('./deploymentRunner');

module.exports = {
  getInstallationVersions,
  getDetailedArtifactVersions,
  deleteArtifactVersion,
  deleteBatchArtifactVersions,
  cleanupOldArtifactVersions,
  sortVersionsByNewest,
  resolveMinioAppPath,
  getEnvFiles,
  readEnvFileContent,
  parseEnvContent,
  serializeEnvKv,
  createEnvFile,
  saveEnvFile,
  deleteEnvFile,
  compareEnvFiles,
  executeSSHCommand,
  executeSSHCommandStream,
  generateMinioClientResolutionSnippet,
  generateBatchDownloadScript,
  generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet,
  deployPodApp,
  deployBatchPodAppServerStream
};
