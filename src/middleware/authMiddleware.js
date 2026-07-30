const jwt = require('jsonwebtoken');
const dbAsync = require('../services/db');

const JWT_SECRET = process.env.JWT_SECRET;

/**
 * Middleware to require valid JWT authentication and approved status
 */
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log(`❌ [requireAuth] Gagal: Header Authorization tidak ditemukan atau format bukan 'Bearer <token>'.`);
      return res.status(401).json({
        success: false,
        error: 'Akses ditolak. Silakan login menggunakan akun Google terlebih dahulu.'
      });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);

    // Verify user in SQLite DB
    const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
    if (!user) {
      console.log(`❌ [requireAuth] Gagal: User ID ${decoded.id} tidak ditemukan di DB.`);
      return res.status(401).json({
        success: false,
        error: 'Pengguna tidak ditemukan.'
      });
    }

    if (user.status !== 'approved') {
      console.log(`❌ [requireAuth] Gagal: User ${user.email} berstatus '${user.status}' (belum approved).`);
      return res.status(403).json({
        success: false,
        error: 'Akun Anda belum disetujui oleh Super Admin (Bharata).'
      });
    }

    req.user = user;
    next();
  } catch (err) {
    console.log(`❌ [requireAuth] Gagal verifikasi JWT:`, err.message);
    return res.status(401).json({
      success: false,
      error: 'Sesi login telah kedaluwarsa atau tidak valid. Silakan login kembali.'
    });
  }
}

/**
 * Middleware to require super_admin role for user management actions
 */
async function requireSuperAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'super_admin') {
    return res.status(403).json({
      success: false,
      error: 'Hanya Super Admin yang berhak menyetujui atau mengelola akun pengguna.'
    });
  }
  next();
}

module.exports = {
  requireAuth,
  requireSuperAdmin
};
