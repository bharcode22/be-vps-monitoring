const express = require('express');
const router = express.Router();
const vpsController = require('../controllers/vpsController');
const authController = require('../controllers/authController');
const dockerController = require('../controllers/dockerController');
const scriptController = require('../controllers/scriptController');
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');

// Health check endpoint
router.get('/health', vpsController.getHealth);

// Public Read-only routes (Guests can view metrics & history)
router.get('/vps', vpsController.getAllServers);
router.get('/vps/:id/history', vpsController.getServerHistory);
router.get('/settings', vpsController.getSettings);

// Public Auth routes
router.post('/auth/google', authController.googleLogin);

// Protected Auth & Admin User Management routes
router.get('/auth/me', requireAuth, authController.getMe);
router.get('/auth/users', requireAuth, requireSuperAdmin, authController.getAllUsers);
router.put('/auth/users/:id/status', requireAuth, requireSuperAdmin, authController.updateUserStatus);

// Protected VPS / POD / Database / Storage Server CRUD routes (Requires Approved Admin Login)
router.post('/vps/vps', requireAuth, vpsController.createVps);
router.post('/vps/pod', requireAuth, vpsController.createPod);
router.post('/vps/database', requireAuth, vpsController.createDatabase);
router.post('/vps/storage', requireAuth, vpsController.createStorage);
router.post('/vps', requireAuth, vpsController.createServer);
router.put('/vps/:id', requireAuth, vpsController.updateServer);
router.delete('/vps/:id', requireAuth, vpsController.deleteServer);
router.post('/vps/test-connection', requireAuth, vpsController.testConnection);
router.post('/settings', requireAuth, vpsController.saveSetting);

// Protected Docker Apps Management routes (Requires Approved Admin Login)
router.get('/vps/:id/docker', requireAuth, dockerController.getContainers);
router.post('/vps/:id/docker/restart', requireAuth, dockerController.restartContainer);
router.get('/vps/:id/docker/:containerName/logs', requireAuth, dockerController.getContainerLogs);

// Protected VPS Exec Script routes (Requires Approved Admin Login)
router.post('/vps/:id/scripts/run', requireAuth, scriptController.executeScript);

module.exports = router;
