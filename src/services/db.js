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
 */
function convertSqlPlaceholders(sql) {
  let paramIndex = 1;
  return sql.replace(/\?/g, () => `$${paramIndex++}`);
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
      const lastInsertRowid = (result.rows && result.rows[0] && result.rows[0].id) ? result.rows[0].id : null;
      return {
        lastInsertRowid,
        changes: result.rowCount || 0
      };
    } catch (err) {
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

// Initialize connection test and Super Admin check
async function initPostgresConnection() {
  try {
    const client = await pool.connect();
    console.log('🐘 Terhubung sukses ke PostgreSQL Database di Cloud RDS!');
    client.release();

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
  } catch (err) {
    console.error('❌ Gagal terhubung ke PostgreSQL RDS:', err.message);
  }
}

initPostgresConnection();

module.exports = dbAsync;
module.exports.dbAsync = dbAsync;
module.exports.prisma = prisma;
module.exports.pool = pool;
