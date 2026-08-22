const express = require('express');
const router = express.Router();
const vpsController = require('../controllers/vpsController');
const authController = require('../controllers/authController');
const dockerController = require('../controllers/dockerController');
const pm2Controller = require('../controllers/pm2Controller');
const scriptController = require('../controllers/scriptController');
const soundController = require('../controllers/soundController');
const podConfigController = require('../controllers/podConfigController');
const syncController = require('../controllers/syncController');
const rabbitmqController = require('../controllers/rabbitmqController');
const installationController = require('../controllers/installationController');
const bundleController = require('../controllers/bundleController');
const envController = require('../controllers/envController');
const heartbeatController = require('../controllers/heartbeatController');
const contentController = require('../controllers/contentController');
const { requireAuth, requireSuperAdmin, optionalAuth } = require('../middleware/authMiddleware');

// 1. Health check & Settings
router.get('/health', vpsController.getHealth);
router.get('/settings', vpsController.getSettings);
router.post('/settings', requireAuth, vpsController.saveSetting);

// 2. Public Auth routes
router.post('/auth/google', authController.googleLogin);
router.get('/auth/me', requireAuth, authController.getMe);
router.get('/auth/users', requireAuth, requireSuperAdmin, authController.getAllUsers);
router.put('/auth/users/:id/status', requireAuth, requireSuperAdmin, authController.updateUserStatus);

// 3. Heartbeat & Geo-Location Sync routes
router.get('/heartbeat/live', optionalAuth, heartbeatController.getHeartbeatData);
router.post('/heartbeat/sync', requireAuth, heartbeatController.syncHeartbeatToServers);

// 4. POD v3 Installation, Bundles & Deployment History routes (MUST BE DECLARED BEFORE /vps/:id/...)
router.get('/vps/installation/env-files', optionalAuth, installationController.getEnvFiles);
router.get('/vps/installation/versions', optionalAuth, installationController.getVersions);
router.get('/vps/installation/minio-artifacts/details', optionalAuth, installationController.getArtifactDetails);
router.delete('/vps/installation/minio-artifacts/version', requireAuth, installationController.deleteArtifactVersion);
router.post('/vps/installation/minio-artifacts/batch-delete', requireAuth, installationController.deleteBatchArtifactVersions);
router.post('/vps/installation/minio-artifacts/cleanup-older', requireAuth, installationController.cleanupOldArtifactVersions);
router.post('/vps/installation/deploy', optionalAuth, installationController.deployApp);
router.get('/vps/installation/history', optionalAuth, installationController.getDeploymentHistory);
router.get('/vps/installation/history/:id', optionalAuth, installationController.getDeploymentDetail);
router.delete('/vps/installation/history/:id', requireAuth, installationController.deleteDeploymentHistory);
router.post('/vps/installation/history/cleanup', requireAuth, installationController.cleanupDeploymentHistory);
router.get('/vps/installation/pod-versions', optionalAuth, installationController.getPodAppVersions);
router.post('/vps/installation/pod-versions/scan', optionalAuth, installationController.scanPodAppVersions);

// POD v3 Bundle Version Routes
router.get('/vps/installation/bundles', optionalAuth, bundleController.getBundles);
router.get('/vps/installation/bundles/pod-matrix', optionalAuth, bundleController.getPodBundleMatrix);
router.get('/vps/installation/bundles/:id', optionalAuth, bundleController.getBundleDetail);
router.post('/vps/installation/bundles', requireAuth, bundleController.createBundle);
router.put('/vps/installation/bundles/:id', requireAuth, bundleController.updateBundle);
router.delete('/vps/installation/bundles/:id', requireAuth, bundleController.deleteBundle);
router.post('/vps/installation/bundles/assign', requireAuth, bundleController.assignPodBundle);

// 5. Environment Manager & Comparison routes
router.get('/vps/env-manager/files', requireAuth, envController.getAllEnvFiles);
router.post('/vps/env-manager/files', requireAuth, envController.handleCreateEnvFile);
router.put('/vps/env-manager/files/:filename', requireAuth, envController.handleSaveEnvFile);
router.delete('/vps/env-manager/files/:filename', requireAuth, envController.handleDeleteEnvFile);
router.post('/vps/env-manager/compare', requireAuth, envController.handleCompareEnvFiles);

// 6. AWS S3 Content Management & POD v3 Storage Cleanup routes
router.get('/vps/content/s3/folders', optionalAuth, contentController.getS3Folders);
router.get('/vps/content/s3/files', optionalAuth, contentController.getS3FolderFiles);
router.delete('/vps/content/s3/folder/:code', requireAuth, contentController.deleteS3Folder);
router.get('/vps/content/pods/storage', optionalAuth, contentController.getPodsStorage);
router.get('/vps/content/pods/:id/scan', optionalAuth, contentController.scanPodJunk);
router.post('/vps/content/pods/cleanup', requireAuth, contentController.cleanupPodJunk);
router.post('/vps/content/pods/sync', requireAuth, contentController.syncS3ToPod);
router.post('/vps/content/matrix/check-pods', optionalAuth, contentController.checkCodeOnPods);
router.post('/vps/content/pods/delete-code', requireAuth, contentController.deleteCodeOnPod);
router.post('/vps/content/batch-delete', requireAuth, contentController.batchDeleteCode);
router.get('/vps/content/pods/file-stream', optionalAuth, contentController.streamPodFile);


// 7. Category-specific Static CRUD routes
router.get('/vps/vps', optionalAuth, vpsController.getVpsServers);
router.post('/vps/vps', requireAuth, vpsController.createVps);
router.put('/vps/vps/:id', requireAuth, vpsController.updateVps);
router.delete('/vps/vps/:id', requireAuth, vpsController.deleteVps);

router.get('/vps/pod', optionalAuth, vpsController.getPodServers);
router.post('/vps/pod', requireAuth, vpsController.createPod);
router.put('/vps/pod/:id', requireAuth, vpsController.updatePod);
router.delete('/vps/pod/:id', requireAuth, vpsController.deletePod);

router.get('/vps/database', optionalAuth, vpsController.getDatabaseServers);
router.post('/vps/database', requireAuth, vpsController.createDatabase);
router.put('/vps/database/:id', requireAuth, vpsController.updateDatabase);
router.delete('/vps/database/:id', requireAuth, vpsController.deleteDatabase);

router.get('/vps/storage', optionalAuth, vpsController.getStorageServers);
router.post('/vps/storage', requireAuth, vpsController.createStorage);
router.put('/vps/storage/:id', requireAuth, vpsController.updateStorage);
router.delete('/vps/storage/:id', requireAuth, vpsController.deleteStorage);

// 7. General Server list & test
router.get('/vps', optionalAuth, vpsController.getAllServers);
router.post('/vps', requireAuth, vpsController.createServer);
router.post('/vps/test-connection', requireAuth, vpsController.testConnection);

// 8. Sounds & Metadata Validation routes
router.get('/vps/sounds/compare', requireAuth, soundController.compareAllPodSounds);
router.get('/vps/metadata/compare', requireAuth, soundController.compareAllPodMetadata);

// 9. Database Synchronization routes
router.get('/sync/info', requireAuth, syncController.getSyncInfo);
router.post('/sync/test-connection', requireAuth, syncController.testSyncConnections);
router.post('/sync/test-single', requireAuth, syncController.testSingleConnection);
router.post('/sync/compare-schema', requireAuth, syncController.compareSyncSchema);
router.post('/sync/perform', requireAuth, syncController.executeSync);

// 10. RabbitMQ Monitoring & Management routes
router.get('/rabbitmq', requireAuth, rabbitmqController.getRabbitMqs);
router.post('/rabbitmq', requireAuth, rabbitmqController.createRabbitMq);
router.put('/rabbitmq/:id', requireAuth, rabbitmqController.updateRabbitMq);
router.delete('/rabbitmq/:id', requireAuth, rabbitmqController.deleteRabbitMq);
router.get('/rabbitmq/:id/status', requireAuth, rabbitmqController.getRabbitMqStatus);
router.post('/rabbitmq/:id/commands/execute', requireAuth, rabbitmqController.executeCommand);
router.post('/rabbitmq/trace-event', rabbitmqController.receiveTraceEvent);

// 11. Dynamic / Parameterized routes by Server ID (MUST BE AT THE END)
router.get('/vps/:id/history', optionalAuth, vpsController.getServerHistory);
router.post('/vps/:id/deploy-backend', requireAuth, vpsController.redeployBackend);
router.put('/vps/:id', requireAuth, vpsController.updateServer);
router.delete('/vps/:id', requireAuth, vpsController.deleteServer);

// Docker management
router.get('/vps/:id/docker', requireAuth, dockerController.getContainers);
router.post('/vps/:id/docker/restart', requireAuth, dockerController.restartContainer);
router.post('/vps/:id/docker/stop', requireAuth, dockerController.stopContainer);
router.post('/vps/:id/docker/remove', requireAuth, dockerController.removeContainer);
router.get('/vps/:id/docker/:containerName/logs', requireAuth, dockerController.getContainerLogs);

// PM2 management
router.get('/vps/:id/pm2', requireAuth, pm2Controller.getApps);
router.post('/vps/:id/pm2/restart', requireAuth, pm2Controller.restartApp);
router.post('/vps/:id/pm2/stop', requireAuth, pm2Controller.stopApp);
router.post('/vps/:id/pm2/delete', requireAuth, pm2Controller.deleteApp);
router.get('/vps/:id/pm2/:appName/logs', requireAuth, pm2Controller.getAppLogs);

// Exec scripts & Sound validation
router.post('/vps/:id/scripts/run', requireAuth, scriptController.executeScript);
router.get('/vps/:id/sounds/validate', requireAuth, soundController.validateSounds);
router.get('/vps/:id/pod-config', requireAuth, podConfigController.getPodConfig);
router.put('/vps/:id/pod-config', requireAuth, podConfigController.updatePodConfig);

module.exports = router;
