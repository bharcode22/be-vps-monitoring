const jwt = require('jsonwebtoken');
const dbAsync = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;

// In-Memory registry: socketId -> { socketId, userId, userEmail, userName, userPicture, userRole, ipAddress, userAgent, currentView, connectedAt, lastSeenAt }
const activeSocketsMap = new Map();

/**
 * Format Human-Friendly View Labels
 */
function formatViewLabel(viewId) {
  const map = {
    'dashboard': 'Dashboard Monitoring',
    'server-list': 'Daftar Server',
    'pod-activity': 'POD Activity Real-Time',
    'pod-occupancy': 'POD Activity Real-Time',
    'multimedia-sync': 'Multimedia Sync Management',
    'rabbitmq-pod-sync': 'Multimedia Sync Management',
    'storage-manager': 'Storage & Disk Manager',
    'storage': 'Storage & Disk Manager',
    'content-manager': 'Content Management',
    'pod-logs-sync': 'POD Logs Sync (Audit & Pull)',
    'pod-logs': 'POD Logs Sync',
    'master-pod-sync': 'Master POD Sync Matrix',
    'master-sync': 'Master POD Sync Matrix',
    'tnc-sync-manager': 'T&C Sync Manager',
    'pod-topic-debugger': 'POD Topic Matrix Debugger',
    'sync': 'Database Sync (Postgres)',
    'database-users': 'Database Users Management',
    'db-users': 'Database Users Management',
    'user-manager': 'Database Users Management',
    'metadata-comparison': 'Compare Metadata RDS',
    'sounds-comparison': 'Compare Audio Files',
    'env-manager': 'Environment (.env) Manager',
    'rabbitmq': 'RabbitMQ Monitor',
    'installation': 'Installation Guide',
    'settings': 'Settings & Preferences',
    'user-activity': 'Audit Logs & Active Users'
  };
  return map[viewId] || (viewId ? String(viewId) : 'Dashboard Monitoring');
}

/**
 * Extract clean IP address from socket handshake
 */
function extractSocketIp(socket) {
  const forwarded = socket.handshake?.headers?.['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }
  return socket.handshake?.address || socket.conn?.remoteAddress || '127.0.0.1';
}

/**
 * Verify JWT and fetch user profile
 */
async function resolveUserFromToken(token) {
  if (!token) return null;
  try {
    const cleanToken = token.startsWith('Bearer ') ? token.slice(7) : token;
    const decoded = jwt.verify(cleanToken, JWT_SECRET);
    if (!decoded || !decoded.id) return null;

    const user = await dbAsync.get('SELECT id, email, name, picture, role, status FROM users WHERE id = ?', [decoded.id]);
    if (user && user.status === 'approved') {
      return user;
    }
    return null;
  } catch (err) {
    return null;
  }
}

/**
 * Get consolidated list of unique active users currently online
 */
function getActiveUsersList() {
  const usersByEmail = new Map();

  const now = Date.now();
  for (const [socketId, session] of activeSocketsMap.entries()) {
    // Expire stale sessions if no ping in 90s
    if (now - session.lastSeenAt > 90000) {
      activeSocketsMap.delete(socketId);
      continue;
    }

    const emailKey = session.userEmail.toLowerCase();
    if (!usersByEmail.has(emailKey)) {
      usersByEmail.set(emailKey, {
        userId: session.userId,
        email: session.userEmail,
        name: session.userName,
        picture: session.userPicture,
        role: session.userRole,
        ipAddress: session.ipAddress,
        userAgent: session.userAgent,
        currentView: session.currentView,
        currentViewLabel: formatViewLabel(session.currentView),
        connectedAt: session.connectedAt,
        lastSeenAt: session.lastSeenAt,
        sessionCount: 1,
        activeSocketIds: [socketId]
      });
    } else {
      const existing = usersByEmail.get(emailKey);
      existing.sessionCount += 1;
      existing.activeSocketIds.push(socketId);
      // Update with most recent activity
      if (session.lastSeenAt > existing.lastSeenAt) {
        existing.currentView = session.currentView;
        existing.currentViewLabel = formatViewLabel(session.currentView);
        existing.lastSeenAt = session.lastSeenAt;
        existing.ipAddress = session.ipAddress;
      }
    }
  }

  return Array.from(usersByEmail.values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * Broadcast current active users list to all connected clients
 */
function broadcastPresenceUpdate(io) {
  if (!io) return;
  const activeUsers = getActiveUsersList();
  io.emit('presence:users-update', {
    totalActiveUsers: activeUsers.length,
    activeUsers
  });
}

/**
 * Register Socket.IO presence events on new connection
 */
function registerUserPresenceHandlers(socket, io) {
  const ipAddress = extractSocketIp(socket);
  const userAgent = socket.handshake?.headers?.['user-agent'] || '';

  // 1. User declares identity upon opening web app
  socket.on('presence:join', async (payload = {}) => {
    const { token, currentView = 'dashboard' } = payload;
    const user = await resolveUserFromToken(token);

    if (user) {
      activeSocketsMap.set(socket.id, {
        socketId: socket.id,
        userId: user.id,
        userEmail: user.email,
        userName: user.name || user.email.split('@')[0],
        userPicture: user.picture || null,
        userRole: user.role || 'admin',
        ipAddress,
        userAgent,
        currentView: currentView || 'dashboard',
        connectedAt: Date.now(),
        lastSeenAt: Date.now()
      });

      broadcastPresenceUpdate(io);
    }
  });

  // 2. User navigates to a new view/page
  socket.on('presence:navigate', (payload = {}) => {
    const session = activeSocketsMap.get(socket.id);
    if (session) {
      session.currentView = payload.currentView || 'dashboard';
      session.lastSeenAt = Date.now();
      activeSocketsMap.set(socket.id, session);

      broadcastPresenceUpdate(io);
    }
  });

  // 3. Keepalive heartbeat ping
  socket.on('presence:heartbeat', () => {
    const session = activeSocketsMap.get(socket.id);
    if (session) {
      session.lastSeenAt = Date.now();
      activeSocketsMap.set(socket.id, session);
    }
  });

  // 4. Request instant active users snapshot
  socket.on('presence:request-snapshot', () => {
    socket.emit('presence:users-update', {
      totalActiveUsers: getActiveUsersList().length,
      activeUsers: getActiveUsersList()
    });
  });

  // 5. Cleanup on disconnect
  socket.on('disconnect', () => {
    if (activeSocketsMap.has(socket.id)) {
      activeSocketsMap.delete(socket.id);
      broadcastPresenceUpdate(io);
    }
  });
}

module.exports = {
  registerUserPresenceHandlers,
  getActiveUsersList,
  broadcastPresenceUpdate
};
