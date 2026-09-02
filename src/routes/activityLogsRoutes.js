const express = require('express');
const router = express.Router();
const { requireAuth, requireSuperAdmin } = require('../middleware/authMiddleware');
const {
  getActivityLogs,
  getActivityStats,
  purgeOldActivityLogs
} = require('../services/activityLoggerService');
const { getActiveUsersList } = require('../services/userPresenceService');

// All routes in this router require valid JWT authentication AND Super Admin role
router.use(requireAuth, requireSuperAdmin);

/**
 * GET /api/activity-logs/active-users
 * Returns list of users currently online and using the application
 */
router.get('/active-users', async (req, res) => {
  try {
    const activeUsers = getActiveUsersList();
    return res.json({
      success: true,
      totalActiveUsers: activeUsers.length,
      activeUsers
    });
  } catch (err) {
    console.error('Error in /api/activity-logs/active-users:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal mengambil data pengguna aktif.'
    });
  }
});

/**
 * GET /api/activity-logs/stats
 * Returns KPI metrics and action summaries
 */
router.get('/stats', async (req, res) => {
  try {
    const stats = await getActivityStats();
    return res.json({
      success: true,
      stats
    });
  } catch (err) {
    console.error('Error in /api/activity-logs/stats:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal mengambil statistik aktivitas.'
    });
  }
});

/**
 * GET /api/activity-logs
 * Paginated list of user activity & audit logs
 */
router.get('/', async (req, res) => {
  try {
    const {
      page = 1,
      limit = 25,
      category,
      userEmail,
      action,
      status,
      search,
      dateFrom,
      dateTo
    } = req.query;

    const result = await getActivityLogs({
      page,
      limit,
      category,
      userEmail,
      action,
      status,
      search,
      dateFrom,
      dateTo
    });

    return res.json({
      success: true,
      ...result
    });
  } catch (err) {
    console.error('Error in /api/activity-logs:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal mengambil data riwayat log aktivitas.'
    });
  }
});

/**
 * GET /api/activity-logs/export
 * Export audit logs to CSV or JSON format
 */
router.get('/export', async (req, res) => {
  try {
    const {
      format = 'csv',
      category,
      userEmail,
      action,
      status,
      search,
      dateFrom,
      dateTo
    } = req.query;

    const result = await getActivityLogs({
      page: 1,
      limit: 10000,
      category,
      userEmail,
      action,
      status,
      search,
      dateFrom,
      dateTo
    });

    const logs = result.logs || [];

    if (format.toLowerCase() === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.json"`);
      return res.send(JSON.stringify(logs, null, 2));
    }

    // Export CSV
    const headers = [
      'ID',
      'Waktu',
      'User Email',
      'User Name',
      'Role',
      'Kategori',
      'Aksi',
      'Target',
      'Deskripsi',
      'Status',
      'IP Address',
      'User Agent'
    ];

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const rows = logs.map(log => [
      log.id,
      new Date(log.created_at).toISOString(),
      escapeCsv(log.user_email),
      escapeCsv(log.user_name),
      escapeCsv(log.user_role),
      escapeCsv(log.category),
      escapeCsv(log.action),
      escapeCsv(log.target),
      escapeCsv(log.description),
      escapeCsv(log.status),
      escapeCsv(log.ip_address),
      escapeCsv(log.user_agent)
    ].join(','));

    const csvContent = [headers.join(','), ...rows].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit_logs_${Date.now()}.csv"`);
    return res.send(csvContent);
  } catch (err) {
    console.error('Error exporting logs:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal mengekspor riwayat log.'
    });
  }
});

/**
 * DELETE /api/activity-logs/purge
 * Purge logs older than X days
 */
router.delete('/purge', async (req, res) => {
  try {
    const { days = 90 } = req.body;
    const result = await purgeOldActivityLogs(days);
    return res.json({
      success: true,
      message: `Berhasil menghapus ${result.purgedCount} log aktivitas lama (> ${result.daysKept} hari).`,
      ...result
    });
  } catch (err) {
    console.error('Error in /api/activity-logs/purge:', err);
    return res.status(500).json({
      success: false,
      error: 'Gagal menghapus log lama.'
    });
  }
});

module.exports = router;
