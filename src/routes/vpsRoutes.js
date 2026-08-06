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
const { requireAuth, requireSuperAdmin, optionalAuth } = require('../middleware/authMiddleware');

// Health check endpoint
router.get('/health', vpsController.getHealth);

// Public Read-only routes (Guests can view metrics & history, host details masked when not logged in)
router.get('/vps/vps', optionalAuth, vpsController.getVpsServers);
router.get('/vps/pod', optionalAuth, vpsController.getPodServers);
router.get('/vps/database', optionalAuth, vpsController.getDatabaseServers);
router.get('/vps/storage', optionalAuth, vpsController.getStorageServers);
router.get('/vps', optionalAuth, vpsController.getAllServers);
router.get('/vps/:id/history', optionalAuth, vpsController.getServerHistory);
router.get('/settings', vpsController.getSettings);

// Public Auth routes
router.post('/auth/google', authController.googleLogin);

// Protected Auth & Admin User Management routes
router.get('/auth/me', requireAuth, authController.getMe);
router.get('/auth/users', requireAuth, requireSuperAdmin, authController.getAllUsers);
router.put('/auth/users/:id/status', requireAuth, requireSuperAdmin, authController.updateUserStatus);

// Protected Dedicated CRUD routes for each infrastructure category (Requires Approved Admin Login)
router.post('/vps/vps', requireAuth, vpsController.createVps);
router.put('/vps/vps/:id', requireAuth, vpsController.updateVps);
router.delete('/vps/vps/:id', requireAuth, vpsController.deleteVps);

router.post('/vps/pod', requireAuth, vpsController.createPod);
router.put('/vps/pod/:id', requireAuth, vpsController.updatePod);
router.delete('/vps/pod/:id', requireAuth, vpsController.deletePod);

router.post('/vps/database', requireAuth, vpsController.createDatabase);
router.put('/vps/database/:id', requireAuth, vpsController.updateDatabase);
router.delete('/vps/database/:id', requireAuth, vpsController.deleteDatabase);

router.post('/vps/storage', requireAuth, vpsController.createStorage);
router.put('/vps/storage/:id', requireAuth, vpsController.updateStorage);
router.delete('/vps/storage/:id', requireAuth, vpsController.deleteStorage);

// Generic Fallback CRUD routes
router.post('/vps', requireAuth, vpsController.createServer);
router.put('/vps/:id', requireAuth, vpsController.updateServer);
router.delete('/vps/:id', requireAuth, vpsController.deleteServer);
router.post('/vps/test-connection', requireAuth, vpsController.testConnection);
router.post('/vps/:id/deploy-backend', requireAuth, vpsController.redeployBackend);
router.post('/settings', requireAuth, vpsController.saveSetting);

// Protected Docker Apps Management routes (Requires Approved Admin Login)
router.get('/vps/:id/docker', requireAuth, dockerController.getContainers);
router.post('/vps/:id/docker/restart', requireAuth, dockerController.restartContainer);
router.post('/vps/:id/docker/stop', requireAuth, dockerController.stopContainer);
router.post('/vps/:id/docker/remove', requireAuth, dockerController.removeContainer);
router.get('/vps/:id/docker/:containerName/logs', requireAuth, dockerController.getContainerLogs);

// Protected PM2 Apps Management routes (Requires Approved Admin Login)
router.get('/vps/:id/pm2', requireAuth, pm2Controller.getApps);
router.post('/vps/:id/pm2/restart', requireAuth, pm2Controller.restartApp);
router.post('/vps/:id/pm2/stop', requireAuth, pm2Controller.stopApp);
router.post('/vps/:id/pm2/delete', requireAuth, pm2Controller.deleteApp);
router.get('/vps/:id/pm2/:appName/logs', requireAuth, pm2Controller.getAppLogs);

// Protected VPS Exec Script routes (Requires Approved Admin Login)
router.post('/vps/:id/scripts/run', requireAuth, scriptController.executeScript);

// Protected Sound & Video Metadata Validation route
router.get('/vps/:id/sounds/validate', requireAuth, soundController.validateSounds);
router.get('/vps/sounds/compare', requireAuth, soundController.compareAllPodSounds);
router.get('/vps/metadata/compare', requireAuth, soundController.compareAllPodMetadata);

// Protected Pod Configuration routes (Requires Approved Admin Login)
router.get('/vps/:id/pod-config', requireAuth, podConfigController.getPodConfig);
router.put('/vps/:id/pod-config', requireAuth, podConfigController.updatePodConfig);

// Protected Database Synchronization routes (Requires Approved Admin Login)
router.get('/sync/info', requireAuth, syncController.getSyncInfo);
router.post('/sync/test-connection', requireAuth, syncController.testSyncConnections);
router.post('/sync/test-single', requireAuth, syncController.testSingleConnection);
router.post('/sync/compare-schema', requireAuth, syncController.compareSyncSchema);
router.post('/sync/perform', requireAuth, syncController.executeSync);

// Protected RabbitMQ Monitoring & Management routes
router.get('/rabbitmq', requireAuth, rabbitmqController.getRabbitMqs);
router.post('/rabbitmq', requireAuth, rabbitmqController.createRabbitMq);
router.put('/rabbitmq/:id', requireAuth, rabbitmqController.updateRabbitMq);
router.delete('/rabbitmq/:id', requireAuth, rabbitmqController.deleteRabbitMq);
router.get('/rabbitmq/:id/status', requireAuth, rabbitmqController.getRabbitMqStatus);
router.post('/rabbitmq/:id/commands/execute', requireAuth, rabbitmqController.executeCommand);
router.post('/rabbitmq/trace-event', rabbitmqController.receiveTraceEvent);

module.exports = router;
