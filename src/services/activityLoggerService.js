const { prisma, pool } = require('./db');

let socketIoInstance = null;

/**
 * Set the global Socket.IO instance for real-time activity broadcast
 */
function setActivitySocketIo(io) {
  socketIoInstance = io;
}

/**
 * Extract clean client IP address from express request
 */
function extractClientIp(req) {
  if (!req) return '127.0.0.1';
  const forwarded = req.headers?.['x-forwarded-for'];
  if (forwarded) {
    const list = forwarded.split(',');
    return list[0].trim();
  }
  return req.socket?.remoteAddress || req.ip || '127.0.0.1';
}

/**
 * Extract user info from req or explicit params
 */
function extractUserInfo(req, explicitUser = {}) {
  const user = req?.user || explicitUser || {};
  return {
    userId: user.id || explicitUser.userId || null,
    userEmail: user.email || explicitUser.userEmail || 'system@system.local',
    userName: user.name || explicitUser.userName || user.email || 'Pengguna',
    userRole: user.role || explicitUser.userRole || 'admin'
  };
}

/**
 * Log user activity into PostgreSQL and emit real-time event to connected Super Admins
 * 
 * @param {Object|null} req Express request or null
 * @param {Object} payload Log payload
 * @param {string} payload.action e.g. 'LOGIN', 'DEPLOY_BUNDLE', 'UPLOAD_MEDIA', 'MULTIMEDIA_POD_SYNC', 'RESET_MODULE'
 * @param {string} payload.category e.g. 'AUTH', 'MULTIMEDIA', 'STORAGE', 'POD_ACTIVITY', 'DEPLOYMENT', 'SERVER', 'SYNC', 'USERS'
 * @param {string} [payload.target] e.g. 'Pod #35 (Jakarta)', 'Asset header.mp4'
 * @param {string} [payload.description] Human-readable description
 * @param {Object|string} [payload.details] Additional JSON metadata
 * @param {string} [payload.status] 'SUCCESS' | 'FAILED' | 'DENIED'
 * @param {Object} [payload.explicitUser] Fallback user info if req is null (for socket handlers)
 */
async function logUserActivity(req, payload = {}) {
  try {
    const {
      action,
      category = 'SYSTEM',
      target = null,
      description = null,
      details = null,
      status = 'SUCCESS',
      explicitUser = {}
    } = payload;

    if (!action) return null;

    const { userId, userEmail, userName, userRole } = extractUserInfo(req, explicitUser);
    const ipAddress = extractClientIp(req);
    const userAgent = req?.headers?.['user-agent'] || (explicitUser.userAgent || null);

    const detailsStr = details
      ? (typeof details === 'object' ? JSON.stringify(details) : String(details))
      : null;

    // Insert to DB using raw pool / prisma
    const query = `
      INSERT INTO user_activity_logs (
        user_id, user_email, user_name, user_role,
        action, category, target, description, details,
        status, ip_address, user_agent, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP)
      RETURNING *;
    `;

    const values = [
      userId,
      userEmail,
      userName,
      userRole,
      action.toUpperCase(),
      category.toUpperCase(),
      target,
      description,
      detailsStr,
      status.toUpperCase(),
      ipAddress,
      userAgent
    ];

    const result = await pool.query(query, values);
    const savedLog = result.rows[0];

    // Broadcast to live presence & audit subscribers
    if (socketIoInstance) {
      socketIoInstance.emit('user-activity:new', savedLog);
    }

    return savedLog;
  } catch (err) {
    console.warn('⚠️ [ActivityLogger] Failed to log activity:', err.message);
    return null;
  }
}

/**
 * Fetch paginated activity logs with flexible filters
 */
async function getActivityLogs({
  page = 1,
  limit = 25,
  category = null,
  userEmail = null,
  action = null,
  status = null,
  search = null,
  dateFrom = null,
  dateTo = null
} = {}) {
  const offset = (Math.max(1, parseInt(page, 10)) - 1) * parseInt(limit, 10);
  const pageSize = Math.min(100, Math.max(1, parseInt(limit, 10)));

  const conditions = [];
  const params = [];

  if (category && category !== 'ALL') {
    params.push(category.toUpperCase());
    conditions.push(`category = $${params.length}`);
  }

  if (userEmail && userEmail !== 'ALL') {
    params.push(userEmail.toLowerCase());
    conditions.push(`LOWER(user_email) = $${params.length}`);
  }

  if (action && action !== 'ALL') {
    params.push(action.toUpperCase());
    conditions.push(`action = $${params.length}`);
  }

  if (status && status !== 'ALL') {
    params.push(status.toUpperCase());
    conditions.push(`status = $${params.length}`);
  }

  if (search && search.trim()) {
    params.push(`%${search.trim().toLowerCase()}%`);
    const idx = params.length;
    conditions.push(`(
      LOWER(user_name) LIKE $${idx} OR 
      LOWER(user_email) LIKE $${idx} OR 
      LOWER(action) LIKE $${idx} OR 
      LOWER(target) LIKE $${idx} OR 
      LOWER(description) LIKE $${idx} OR
      LOWER(ip_address) LIKE $${idx}
    )`);
  }

  if (dateFrom) {
    params.push(new Date(dateFrom).toISOString());
    conditions.push(`created_at >= $${params.length}`);
  }

  if (dateTo) {
    const endOfDay = new Date(dateTo);
    endOfDay.setHours(23, 59, 59, 999);
    params.push(endOfDay.toISOString());
    conditions.push(`created_at <= $${params.length}`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Count query
  const countQuery = `SELECT COUNT(*) as total FROM user_activity_logs ${whereClause};`;
  const countResult = await pool.query(countQuery, params);
  const total = parseInt(countResult.rows[0].total, 10);

  // Data query
  const dataParams = [...params, pageSize, offset];
  const dataQuery = `
    SELECT * FROM user_activity_logs 
    ${whereClause} 
    ORDER BY created_at DESC 
    LIMIT $${params.length + 1} OFFSET $${params.length + 2};
  `;
  const dataResult = await pool.query(dataQuery, dataParams);

  return {
    logs: dataResult.rows,
    pagination: {
      total,
      page: parseInt(page, 10),
      limit: pageSize,
      totalPages: Math.ceil(total / pageSize)
    }
  };
}

/**
 * Fetch KPI statistics for Activity & Audit Logs
 */
async function getActivityStats() {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    const [todayCountRes, totalCountRes, failedCountRes, topUsersRes, categoryStatsRes] = await Promise.all([
      // Total actions today
      pool.query(`SELECT COUNT(*) as count FROM user_activity_logs WHERE created_at >= $1;`, [startOfToday]),
      // Total actions all time
      pool.query(`SELECT COUNT(*) as count FROM user_activity_logs;`),
      // Total failed/denied actions
      pool.query(`SELECT COUNT(*) as count FROM user_activity_logs WHERE status IN ('FAILED', 'DENIED');`),
      // Top active users (last 7 days)
      pool.query(`
        SELECT user_email, user_name, user_role, COUNT(*) as count 
        FROM user_activity_logs 
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY user_email, user_name, user_role 
        ORDER BY count DESC 
        LIMIT 5;
      `),
      // Actions breakdown by category (last 7 days)
      pool.query(`
        SELECT category, COUNT(*) as count 
        FROM user_activity_logs 
        WHERE created_at >= NOW() - INTERVAL '7 days'
        GROUP BY category 
        ORDER BY count DESC;
      `)
    ]);

    return {
      todayActions: parseInt(todayCountRes.rows[0]?.count || 0, 10),
      totalActions: parseInt(totalCountRes.rows[0]?.count || 0, 10),
      failedActions: parseInt(failedCountRes.rows[0]?.count || 0, 10),
      topUsers: topUsersRes.rows,
      categoryStats: categoryStatsRes.rows
    };
  } catch (err) {
    console.error('Error fetching activity stats:', err);
    return {
      todayActions: 0,
      totalActions: 0,
      failedActions: 0,
      topUsers: [],
      categoryStats: []
    };
  }
}

/**
 * Purge logs older than X days
 */
async function purgeOldActivityLogs(daysToKeep = 90) {
  const days = Math.max(7, parseInt(daysToKeep, 10) || 90);
  const result = await pool.query(
    `DELETE FROM user_activity_logs WHERE created_at < NOW() - ($1 || ' days')::INTERVAL RETURNING id;`,
    [days]
  );
  return {
    purgedCount: result.rowCount,
    daysKept: days
  };
}

module.exports = {
  setActivitySocketIo,
  logUserActivity,
  getActivityLogs,
  getActivityStats,
  purgeOldActivityLogs
};
