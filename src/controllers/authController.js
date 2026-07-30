const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const dbAsync = require('../services/db');

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const JWT_SECRET = process.env.JWT_SECRET;
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL;
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/**
 * Handle Google OAuth Login / Register
 */
const googleLogin = async (req, res) => {
  try {
    const { credential, access_token } = req.body;
    if (!credential && !access_token) {
      return res.status(400).json({ success: false, error: 'Google credential atau access_token diperlukan.' });
    }

    let googleUser;

    if (access_token) {
      // Verify via Google UserInfo API using Access Token
      const fetch = (await import('node-fetch')).default || globalThis.fetch;
      const resp = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const payload = await resp.json();
      if (!payload.email) {
        return res.status(401).json({ success: false, error: 'Access token Google tidak valid.' });
      }
      googleUser = {
        email: payload.email,
        name: payload.name || payload.email,
        picture: payload.picture || ''
      };
    } else {
      // Verify Google ID Token
      try {
        const ticket = await googleClient.verifyIdToken({
          idToken: credential,
          audience: GOOGLE_CLIENT_ID
        });
        const payload = ticket.getPayload();
        googleUser = {
          email: payload.email,
          name: payload.name,
          picture: payload.picture
        };
      } catch (e) {
        // Fallback HTTP check if library fails
        const fetch = (await import('node-fetch')).default || globalThis.fetch;
        const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
        const payload = await resp.json();
        if (!payload.email) {
          return res.status(401).json({ success: false, error: 'Token Google tidak valid.' });
        }
        googleUser = {
          email: payload.email,
          name: payload.name || payload.email,
          picture: payload.picture || ''
        };
      }
    }

    const { email, name, picture } = googleUser;
    const isSuperAdminEmail = email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase();

    // Check if user exists in DB
    let user = await dbAsync.get('SELECT * FROM users WHERE email = ?', [email]);

    if (!user) {
      // Register new user
      const initialRole = isSuperAdminEmail ? 'super_admin' : 'admin';
      const initialStatus = isSuperAdminEmail ? 'approved' : 'pending';

      const result = await dbAsync.run(
        `INSERT INTO users (email, name, picture, role, status) VALUES (?, ?, ?, ?, ?)`,
        [email, name, picture, initialRole, initialStatus]
      );
      user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [result.lastInsertRowid]);
    } else {
      // Update name & picture if changed
      await dbAsync.run(
        `UPDATE users SET name = ?, picture = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [name, picture, user.id]
      );
      user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [user.id]);
    }

    // Check approval status
    if (user.status !== 'approved') {
      return res.status(403).json({
        success: false,
        status: 'pending',
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          picture: user.picture,
          role: user.role,
          status: user.status
        },
        error: `Akun Anda sedang menunggu persetujuan dari Super Admin (${SUPER_ADMIN_EMAIL}).`
      });
    }

    // Generate JWT Token
    const token = jwt.sign(
      { id: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        picture: user.picture,
        role: user.role,
        status: user.status
      }
    });

  } catch (err) {
    console.error('Google Auth Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Get current user profile
 */
const getMe = async (req, res) => {
  try {
    const user = await dbAsync.get(
      'SELECT id, email, name, picture, role, status, created_at FROM users WHERE id = ?',
      [req.user.id]
    );
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Get all users for admin management panel
 */
const getAllUsers = async (req, res) => {
  try {
    const users = await dbAsync.all(
      'SELECT id, email, name, picture, role, status, created_at FROM users ORDER BY created_at DESC'
    );
    res.json({ success: true, data: users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

/**
 * Update user status (approve / reject / change role)
 */
const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status, role } = req.body;

    const user = await dbAsync.get('SELECT * FROM users WHERE id = ?', [id]);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Pengguna tidak ditemukan' });
    }

    // Prevent demoting primary super admin
    if (user.email.toLowerCase() === SUPER_ADMIN_EMAIL.toLowerCase() && status !== 'approved') {
      return res.status(400).json({ success: false, error: `Tidak dapat menolak akun Super Admin Utama (${SUPER_ADMIN_EMAIL}).` });
    }

    const newStatus = status || user.status;
    const newRole = role || user.role;

    await dbAsync.run(
      'UPDATE users SET status = ?, role = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newStatus, newRole, id]
    );

    res.json({ success: true, message: `Status akun ${user.email} berhasil diperbarui menjadi ${newStatus}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
};

module.exports = {
  googleLogin,
  getMe,
  getAllUsers,
  updateUserStatus
};
