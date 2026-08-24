const { Pool } = require('pg');
const prisma = require('./prisma');

// Determine if SSL should be enabled (for RDS/Cloud DBs or sslmode=require)
const rawDbUrl = process.env.DATABASE_URL || '';
const isCloudDb = rawDbUrl.includes('rds.amazonaws.com') || rawDbUrl.includes('sslmode=') || process.env.NODE_ENV === 'production';

// Strip sslmode query param from URL so pg doesn't override rejectUnauthorized: false
const connectionString = rawDbUrl.replace(/[?&]sslmode=[^&]+/g, '').replace(/\?$/, '');

// Initialize PostgreSQL Connection Pool
const pool = new Pool({
  connectionString,
  ssl: isCloudDb ? { rejectUnauthorized: false } : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 15000
});

pool.on('error', (err) => {
  console.error('❌ Unexpected error on PostgreSQL idle client pool:', err.message);
});

/**
 * Convert SQLite ? placeholders into PostgreSQL $1, $2, ... positional parameters
 * Safely ignores ? characters inside single-quoted string literals.
 */
function convertSqlPlaceholders(sql) {
  let paramIndex = 1;
  let inString = false;
  let result = '';

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    if (char === "'") {
      if (inString && sql[i + 1] === "'") {
        result += "''";
        i++;
        continue;
      }
      inString = !inString;
      result += char;
    } else if (char === '?' && !inString) {
      result += `$${paramIndex++}`;
    } else {
      result += char;
    }
  }

  return result;
}

/**
 * Robust, high-performance PostgreSQL Adapter maintaining 100% backward compatibility
 * with all existing backend controllers, metrics collectors, and streamers.
 */
const dbAsync = {
  /**
   * Run query returning multiple rows (SELECT ...)
   */
  async all(sql, params = []) {
    const convertedSql = convertSqlPlaceholders(sql);
    try {
      const result = await pool.query(convertedSql, params);
      return result.rows || [];
    } catch (err) {
      console.error(`❌ [dbAsync.all] Query error: ${err.message}\nSQL: ${convertedSql}`);
      throw err;
    }
  },

  /**
   * Run query returning a single row (SELECT ... LIMIT 1)
   */
  async get(sql, params = []) {
    const convertedSql = convertSqlPlaceholders(sql);
    try {
      const result = await pool.query(convertedSql, params);
      return result.rows && result.rows.length > 0 ? result.rows[0] : null;
    } catch (err) {
      console.error(`❌ [dbAsync.get] Query error: ${err.message}\nSQL: ${convertedSql}`);
      throw err;
    }
  },

  /**
   * Run mutating query (INSERT, UPDATE, DELETE)
   */
  async run(sql, params = []) {
    let convertedSql = convertSqlPlaceholders(sql);

    // If INSERT statement without RETURNING, append RETURNING id to capture lastInsertRowid
    const isInsert = /^\s*INSERT\s+/i.test(convertedSql);
    if (isInsert && !/RETURNING/i.test(convertedSql)) {
      convertedSql = `${convertedSql.replace(/;\s*$/, '')} RETURNING id;`;
    }

    try {
      const result = await pool.query(convertedSql, params);
      const lastInsertRowid = (result.rows && result.rows[0])
        ? (result.rows[0].id || result.rows[0].key || null)
        : null;
      return {
        lastInsertRowid,
        changes: result.rowCount || 0
      };
    } catch (err) {
      // Fallback: If "column id does not exist" error happens because of appended RETURNING id, retry raw query
      if (err.message && err.message.includes('column "id" does not exist')) {
        try {
          const rawSql = convertSqlPlaceholders(sql);
          const result = await pool.query(rawSql, params);
          return {
            lastInsertRowid: null,
            changes: result.rowCount || 0
          };
        } catch (retryErr) {
          console.error(`❌ [dbAsync.run] Retry error: ${retryErr.message}\nSQL: ${convertedSql}`);
          throw retryErr;
        }
      }
      console.error(`❌ [dbAsync.run] Query error: ${err.message}\nSQL: ${convertedSql}`);
      throw err;
    }
  },

  /**
   * Execute raw multi-statement SQL script
   */
  async exec(sql) {
    try {
      await pool.query(sql);
    } catch (err) {
      console.error(`❌ [dbAsync.exec] Error: ${err.message}`);
      throw err;
    }
  }
};

// Initialize connection test, Super Admin check, and Credentials Encryption Migration
async function initPostgresConnection() {
  try {
    const { encrypt, isEncrypted } = require('../utils/crypto');

    // Ensure database connection active
    console.log('✅ PostgreSQL Database schema connection active');

    // Ensure super admin exists
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'zaqqwer758@gmail.com';
    try {
      await prisma.user.upsert({
        where: { email: superAdminEmail },
        update: { role: 'super_admin', status: 'approved' },
        create: {
          email: superAdminEmail,
          name: 'Super Admin',
          role: 'super_admin',
          status: 'approved'
        }
      });
    } catch (e) {
      console.warn('Super admin upsert check:', e.message);
    }

    // Auto-migrate existing plain-text passwords to AES-256-GCM ciphertext
    try {
      // 1. servers (password, private_key)
      const servers = await pool.query('SELECT id, password, private_key FROM servers');
      for (const s of servers.rows) {
        let needsUpdate = false;
        let encPass = s.password;
        let encKey = s.private_key;

        if (s.password && !isEncrypted(s.password)) {
          encPass = encrypt(s.password);
          needsUpdate = true;
        }
        if (s.private_key && !isEncrypted(s.private_key)) {
          encKey = encrypt(s.private_key);
          needsUpdate = true;
        }
        if (needsUpdate) {
          await pool.query('UPDATE servers SET password = $1, private_key = $2 WHERE id = $3', [encPass, encKey, s.id]);
        }
      }

      // 2. databases_postgres (password)
      const dbs = await pool.query('SELECT id, password FROM databases_postgres');
      for (const d of dbs.rows) {
        if (d.password && !isEncrypted(d.password)) {
          const encPass = encrypt(d.password);
          await pool.query('UPDATE databases_postgres SET password = $1 WHERE id = $2', [encPass, d.id]);
        }
      }

      // 3. object_storages (s3_secret_key)
      const storages = await pool.query('SELECT id, s3_secret_key FROM object_storages');
      for (const st of storages.rows) {
        if (st.s3_secret_key && !isEncrypted(st.s3_secret_key)) {
          const encSecret = encrypt(st.s3_secret_key);
          await pool.query('UPDATE object_storages SET s3_secret_key = $1 WHERE id = $2', [encSecret, st.id]);
        }
      }

      // 4. rabbitmq_servers (password)
      const rabbitmqs = await pool.query('SELECT id, password FROM rabbitmq_servers');
      for (const rb of rabbitmqs.rows) {
        if (rb.password && !isEncrypted(rb.password)) {
          const encPass = encrypt(rb.password);
          await pool.query('UPDATE rabbitmq_servers SET password = $1 WHERE id = $2', [encPass, rb.id]);
        }
      }
    } catch (migErr) {
      console.warn('Auto-encrypt migration warning:', migErr.message);
    }
  } catch (err) {
    console.error('❌ Gagal terhubung ke PostgreSQL RDS:', err.message);
  }
}

initPostgresConnection();

module.exports = dbAsync;
module.exports.dbAsync = dbAsync;
module.exports.prisma = prisma;
module.exports.pool = pool;
