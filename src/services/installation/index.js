const { getInstallationVersions, sortVersionsByNewest, resolveMinioAppPath } = require('./minioService');
const { getEnvFiles, readEnvFileContent } = require('./envService');
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
  sortVersionsByNewest,
  resolveMinioAppPath,
  getEnvFiles,
  readEnvFileContent,
  executeSSHCommand,
  executeSSHCommandStream,
  generateMinioClientResolutionSnippet,
  generateBatchDownloadScript,
  generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet,
  deployPodApp,
  deployBatchPodAppServerStream
};
