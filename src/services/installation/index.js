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

const {
  scanServerInstalledVersions,
  scanAllPodAppVersions,
  getPodAppVersionsMatrix
} = require('./versionScanner');

const {
  getAllBundleDefinitions,
  getBundleDefinitionById,
  createBundleDefinition,
  updateBundleDefinition,
  deleteBundleDefinition,
  getPodBundleMatrix,
  assignPodBundleState
} = require('./bundleService');

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
  deployBatchPodAppServerStream,
  scanServerInstalledVersions,
  scanAllPodAppVersions,
  getPodAppVersionsMatrix,
  getAllBundleDefinitions,
  getBundleDefinitionById,
  createBundleDefinition,
  updateBundleDefinition,
  deleteBundleDefinition,
  getPodBundleMatrix,
  assignPodBundleState
};
