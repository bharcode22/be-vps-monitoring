const express = require('express');
const router = express.Router();
const vpsController = require('../controllers/vpsController');
const authController = require('../controllers/authController');
const dockerController = require('../controllers/dockerController');
const screenAppController = require('../controllers/screenAppController');
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
const multimediaUploadController = require('../controllers/multimediaUploadController');
const multimediaSyncController = require('../controllers/multimediaSyncController');
const podTopicController = require('../controllers/podTopicController');
const masterToPodSyncController = require('../controllers/masterToPodSyncController');
const tncSyncController = require('../controllers/tncSyncController');
const masterCrudController = require('../controllers/masterCrudController');
const regenesisLogController = require('../controllers/regenesisLogController');
const podLogsSyncController = require('../controllers/podLogsSyncController');
const podActivityController = require('../controllers/podActivityController');
const flowEditorStorageController = require('../controllers/flowEditorStorageController');
const directS3Controller = require('../controllers/directS3Controller');
const { requireAuth, requireSuperAdmin, optionalAuth } = require('../middleware/authMiddleware');

// 1. Health check, Speedtest & Settings
router.get('/health', vpsController.getHealth);
router.get('/speedtest-data', vpsController.getSpeedtestData);
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
router.get('/vps/content/s3/folders', requireAuth, contentController.getS3Folders);
router.get('/vps/content/s3/files', requireAuth, contentController.getS3FolderFiles);
router.delete('/vps/content/s3/file', requireAuth, contentController.deleteS3SingleFile);
router.delete('/vps/content/s3/folder/:code', requireAuth, contentController.deleteS3Folder);
router.get('/vps/content/pods/storage', requireAuth, contentController.getPodsStorage);
router.get('/vps/content/pods/:id/scan', requireAuth, contentController.scanPodJunk);
router.post('/vps/content/pods/cleanup', requireAuth, contentController.cleanupPodJunk);
router.post('/vps/content/pods/sync', requireAuth, contentController.syncS3ToPod);
router.post('/vps/content/pods/download-code', requireAuth, contentController.downloadCodeFilesToPod);
router.post('/vps/content/pods/download-batch', requireAuth, contentController.downloadCodeFilesToBatchPods);
router.post('/vps/content/pods/check-file-integrity', requireAuth, contentController.checkFileIntegrity);
router.post('/vps/content/matrix/check-pods', requireAuth, contentController.checkCodeOnPods);
router.post('/vps/content/pods/delete-code', requireAuth, contentController.deleteCodeOnPod);
router.post('/vps/content/batch-delete', requireAuth, contentController.batchDeleteCode);
router.get('/vps/content/pods/file-stream', optionalAuth, contentController.streamPodFile);
router.get('/vps/content/s3/proxy-file', optionalAuth, contentController.proxyS3File);
router.get('/vps/content/multimedia-list', optionalAuth, contentController.getMultimediaList);
router.get('/vps/content/multimedia/:soundScapeId', optionalAuth, contentController.getMultimediaBySoundScape);

// Master Multimedia API Token for Direct Browser Upload
router.get('/vps/multimedia/master-token', optionalAuth, multimediaUploadController.getMasterApiToken);

// Direct S3 Presigned Upload & Media Forensik (SHA-256) Routes
router.post('/vps/direct-s3/presigned-urls', optionalAuth, directS3Controller.getPresignedUrls);
router.post('/vps/direct-s3/save-metadata', optionalAuth, directS3Controller.saveMetadataAndForensics);

// Multimedia RabbitMQ Sync to PODs routes
router.get('/vps/multimedia-sync/list', optionalAuth, multimediaSyncController.getMultimediaList);
router.get('/vps/multimedia-sync/inspect-fleet', optionalAuth, multimediaSyncController.inspectFleetStatus);
router.post('/vps/multimedia-sync/inspect-fleet', optionalAuth, multimediaSyncController.inspectFleetStatus);
router.get('/vps/multimedia-sync/inspect-pod/:serverId', optionalAuth, multimediaSyncController.inspectSinglePodStatus);
router.post('/vps/multimedia-sync/control-container', optionalAuth, multimediaSyncController.controlContainer);
router.post('/vps/multimedia-sync/batch-control-containers', optionalAuth, multimediaSyncController.batchControlContainers);
router.post('/vps/multimedia-sync/wake-container', optionalAuth, multimediaSyncController.wakeContainer);
router.post('/vps/multimedia-sync/batch-wake-containers', optionalAuth, multimediaSyncController.batchWakeContainers);
router.post('/vps/multimedia-sync/trigger-resave', optionalAuth, multimediaSyncController.triggerResave);
router.delete('/vps/multimedia-sync/delete/:soundScapeCode', optionalAuth, multimediaSyncController.deleteMultimedia);
router.get('/vps/multimedia-sync/pod-logs/:serverId', optionalAuth, multimediaSyncController.getContainerLogs);

// Docker Build Junk & Fleet Storage Cleanup routes
router.get('/vps/storage/docker/inspect/:serverId', requireAuth, contentController.inspectSinglePodDocker);
router.post('/vps/storage/docker/inspect-all', requireAuth, contentController.inspectAllPodsDocker);
router.post('/vps/storage/docker/cleanup', requireAuth, contentController.cleanupSinglePodDocker);
router.post('/vps/storage/docker/cleanup-batch', requireAuth, contentController.cleanupBatchPodsDocker);

// --- Flow Editor Media Storage (Master RDS, S3 images/, POD V3) ---
router.get('/vps/flow-editor/files', requireAuth, flowEditorStorageController.getFlowEditorFiles);
router.post('/vps/flow-editor/pods/check', requireAuth, flowEditorStorageController.checkFlowFilesOnPods);
router.post('/vps/flow-editor/pods/download', requireAuth, flowEditorStorageController.downloadFlowFilesToSinglePod);
router.post('/vps/flow-editor/pods/download-batch', requireAuth, flowEditorStorageController.downloadFlowFilesToBatchPods);
router.post('/vps/flow-editor/pods/delete', requireAuth, flowEditorStorageController.deleteFlowFileOnPod);
router.post('/vps/flow-editor/s3/delete', requireAuth, flowEditorStorageController.deleteFlowFileOnS3);

// --- T&C / User Sync (Batch Ops) ---
router.post('/tnc-sync/publish-definitions', requireAuth, tncSyncController.publishDefinitions);
router.post('/tnc-sync/pull-consents', requireAuth, tncSyncController.pullConsentsAndDistribute);

// --- Master Data CRUD ---
router.post('/master-crud/:masterId/unified-question-matrix', requireAuth, masterCrudController.saveUnifiedQuestionMatrix);
router.get('/master-crud/:masterId/matrix-by-question/:questionId', requireAuth, masterCrudController.getMatrixByQuestionId);
router.get('/master-crud/:masterId/validate-matrix-questions', requireAuth, masterCrudController.validateMatrixQuestions);
router.get('/master-crud/:masterId/:tableName', requireAuth, masterCrudController.getMasterTableData);
router.post('/master-crud/:masterId/:tableName', requireAuth, masterCrudController.createMasterRow);
router.put('/master-crud/:masterId/:tableName', requireAuth, masterCrudController.updateMasterRow);
router.delete('/master-crud/:masterId/:tableName', requireAuth, masterCrudController.deleteMasterRow);

// --- Media Scanner ---
router.get('/vps/content/pod-rogue-files', requireAuth, contentController.scanAllPodsRogueFiles);
router.post('/vps/content/pod-rogue-files/cleanup', requireAuth, contentController.cleanupRogueFiles);

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

// 11. POD Topics & MQTT Debugger routes
router.get('/pod-topics/matrix', requireAuth, podTopicController.getPodTopicMatrix);
router.get('/pod-topics/mqtt-status', requireAuth, podTopicController.getMqttBrokerStatus);
router.post('/pod-topics/sync', requireAuth, podTopicController.syncPodTopics);
router.post('/pod-topics/register', requireAuth, podTopicController.registerPodTopic);
router.post('/pod-topics/test-publish', requireAuth, podTopicController.testPublishMqtt);
router.get('/pod-topics/:serverId', requireAuth, podTopicController.getPodTopicDetail);

// 12. Master DB to Multi-POD Sync Matrix routes
router.get('/master-pod-sync/masters', requireAuth, masterToPodSyncController.getMasterDatabases);
router.get('/master-pod-sync/tables', requireAuth, masterToPodSyncController.getMasterTables);
router.get('/master-pod-sync/master-table-fast', requireAuth, masterToPodSyncController.getMasterTableFast);
router.get('/master-pod-sync/compare-single-pod', requireAuth, masterToPodSyncController.compareSinglePod);
router.get('/master-pod-sync/matrix', requireAuth, masterToPodSyncController.getTableComparisonMatrix);
router.get('/master-pod-sync/relations', requireAuth, masterToPodSyncController.getTableRelations);
router.get('/master-pod-sync/fleet-audit', requireAuth, masterToPodSyncController.getFleetAudit);
router.post('/master-pod-sync/sync', requireAuth, masterToPodSyncController.performSync);
router.post('/master-pod-sync/sync-relational', requireAuth, masterToPodSyncController.syncRelationalTables);
router.post('/master-pod-sync/sync-single-row', requireAuth, masterToPodSyncController.syncSingleMasterRow);
router.post('/master-pod-sync/pod-to-master', requireAuth, masterToPodSyncController.syncPodToMaster);
router.post('/master-pod-sync/sync-single-pod-row', requireAuth, masterToPodSyncController.syncSinglePodRow);
router.post('/master-pod-sync/check-master-duplicates', requireAuth, masterToPodSyncController.checkMasterDuplicates);
router.post('/master-pod-sync/clean-master-duplicates', requireAuth, masterToPodSyncController.cleanMasterDuplicates);
router.delete('/master-pod-sync/master-row', requireAuth, masterToPodSyncController.deleteMasterRow);
router.delete('/master-pod-sync/pod-row', requireAuth, masterToPodSyncController.deletePodRow);

// 13. Dynamic / Parameterized routes by Server ID (MUST BE AT THE END)
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

// Screen Apps (Native Linux GUI) management
router.get('/vps/:id/screen-apps', requireAuth, screenAppController.getScreenApps);
router.post('/vps/:id/screen-apps/restart', requireAuth, screenAppController.restartApp);
router.post('/vps/:id/screen-apps/stop', requireAuth, screenAppController.stopApp);
router.get('/vps/:id/screen-apps/:appName/logs', requireAuth, screenAppController.getAppLogs);

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

// Regenesis Logs (/home/pod/Documents/RegenesisLogs)
router.get('/vps/:id/regenesis-logs', requireAuth, regenesisLogController.getLogs);
router.get('/vps/:id/regenesis-logs/content', requireAuth, regenesisLogController.getLogContent);
router.get('/vps/:id/regenesis-logs/download', optionalAuth, regenesisLogController.downloadLogFile);
router.delete('/vps/:id/regenesis-logs', requireAuth, regenesisLogController.deleteLog);

// POD Logs Sync (High-Volume POD V3 -> Master RDS)
router.get('/pod-logs-sync/masters', requireAuth, podLogsSyncController.getMasters);
router.get('/pod-logs-sync/pods', requireAuth, podLogsSyncController.getPods);
router.get('/pod-logs-sync/audit', requireAuth, podLogsSyncController.getAudit);
router.post('/pod-logs-sync/pull', requireAuth, podLogsSyncController.pullLogs);
router.get('/pod-logs-sync/master-logs', requireAuth, podLogsSyncController.getMasterLogs);
router.get('/pod-logs-sync/activity-types', requireAuth, podLogsSyncController.getActivityTypes);
router.get('/pod-logs-sync/compare-pod', requireAuth, podLogsSyncController.comparePod);
router.post('/pod-logs-sync/sync-single-row', requireAuth, podLogsSyncController.syncSingleRow);
router.get('/pod-logs-sync/pod-uuid-map', requireAuth, podLogsSyncController.getPodUuidMapController);

// POD Activity (Real-Time Occupancy mod_chair/pob_state & Heartbeat Modules)
router.get('/pod-activity/status', optionalAuth, podActivityController.getStatus);
router.get('/pod-activity/history', optionalAuth, podActivityController.getHistory);
router.post('/pod-activity/simulate', requireAuth, podActivityController.simulate);
router.post('/pod-activity/reconnect', requireAuth, podActivityController.reconnect);
router.get('/pod-activity/heartbeat-modules', optionalAuth, podActivityController.getHeartbeatModules);
router.post('/pod-activity/heartbeat-modules', requireAuth, podActivityController.saveHeartbeatModules);
router.post('/pod-activity/heartbeat-modules/reset', requireAuth, podActivityController.resetHeartbeatModules);
router.get('/pod-activity/heartbeat-thresholds', optionalAuth, podActivityController.getHeartbeatThresholds);
router.get('/pod-activity/pods/:id/events', optionalAuth, podActivityController.getPodEventsHandler);
router.get('/pod-activity/pods/:id/heartbeats', optionalAuth, podActivityController.getPodHeartbeatsHandler);
router.get('/pod-activity/pods/:id/heartbeats/download', optionalAuth, podActivityController.downloadPodHeartbeatsHandler);
router.get('/pod-activity/pods/:id/log-dates', optionalAuth, podActivityController.getPodLogDatesHandler);
router.get('/pod-activity/pods/:id/state', optionalAuth, podActivityController.getPodStateHandler);
router.get('/pod-activity/pods/:id/storage-files', optionalAuth, podActivityController.getPodStorageFilesHandler);
router.get('/pod-activity/daemon-status', optionalAuth, podActivityController.getDaemonStatusHandler);
router.get('/pod-activity/incidents/recent', optionalAuth, podActivityController.getRecentIncidentsHandler);
router.post('/pod-activity/heartbeat-thresholds', optionalAuth, podActivityController.saveHeartbeatThresholds);
router.post('/pod-activity/heartbeat-thresholds/reset', optionalAuth, podActivityController.resetHeartbeatThresholds);

module.exports = router;
