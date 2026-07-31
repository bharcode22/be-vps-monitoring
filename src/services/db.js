const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../../data/monitoring.db');
const dataDir = path.dirname(dbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening SQLite database:', err.message);
  }
});

// Helper promise-based methods for SQLite database
const dbAsync = {
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
      });
    });
  },
  exec(sql) {
    return new Promise((resolve, reject) => {
      db.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
};

// Initialize Tables asynchronously
async function initDb() {
  try {
    await dbAsync.exec(`
      CREATE TABLE IF NOT EXISTS servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER DEFAULT 22,
        username TEXT DEFAULT 'root',
        auth_type TEXT DEFAULT 'password',
        password TEXT,
        private_key TEXT,
        is_local INTEGER DEFAULT 0,
        type TEXT DEFAULT 'vps', -- 'vps' | 'pod'
        pod_version TEXT DEFAULT '', -- 'v2' | 'v3' | ''
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS metrics_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        server_id INTEGER NOT NULL,
        cpu_usage REAL DEFAULT 0,
        cpu_cores INTEGER DEFAULT 1,
        ram_usage REAL DEFAULT 0,
        ram_used_mb REAL DEFAULT 0,
        ram_free_mb REAL DEFAULT 0,
        ram_total_mb REAL DEFAULT 0,
        bandwidth_rx_speed REAL DEFAULT 0,
        bandwidth_tx_speed REAL DEFAULT 0,
        disk_usage REAL DEFAULT 0,
        disk_used_gb REAL DEFAULT 0,
        disk_total_gb REAL DEFAULT 0,
        disk_free_gb REAL DEFAULT 0,
        gpu_usage REAL DEFAULT 0,
        gpu_memory_usage REAL DEFAULT 0,
        gpu_name TEXT DEFAULT '',
        gpu_temp REAL DEFAULT 0,
        ping_ms REAL DEFAULT 0,
        status TEXT DEFAULT 'online',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        picture TEXT,
        role TEXT DEFAULT 'admin',
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS databases_postgres (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        port INTEGER DEFAULT 5432,
        db_name TEXT DEFAULT 'postgres',
        db_user TEXT DEFAULT 'postgres',
        password TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS object_storages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL, -- 'minio' | 's3'
        s3_endpoint TEXT,
        s3_access_key TEXT,
        s3_secret_key TEXT,
        s3_region TEXT DEFAULT 'us-east-1',
        s3_bucket TEXT,
        port INTEGER DEFAULT 9000,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Seed initial Super Admin
    const superAdminEmail = process.env.SUPER_ADMIN_EMAIL || 'zaqqwer758@gmail.com';
    try {
      await dbAsync.run(
        `INSERT INTO users (email, name, role, status) VALUES (?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET role = 'super_admin', status = 'approved'`,
        [superAdminEmail, 'Super Admin', 'super_admin', 'approved']
      );
    } catch (e) { }

    // Migration for existing tables
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN type TEXT DEFAULT 'vps'"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN pod_version TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN db_name TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN db_user TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN s3_endpoint TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN s3_access_key TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN s3_secret_key TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN s3_region TEXT DEFAULT 'us-east-1'"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE servers ADD COLUMN s3_bucket TEXT DEFAULT ''"); } catch (e) { }

    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN cpu_cores INTEGER DEFAULT 1"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN ram_free_mb REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN disk_used_gb REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN disk_total_gb REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN disk_free_gb REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_usage REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_memory_usage REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_name TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_temp REAL DEFAULT 0"); } catch (e) { }

    // Auto-migrate legacy PostgreSQL records from servers table to databases_postgres
    try {
      const legacyDbs = await dbAsync.all("SELECT * FROM servers WHERE type = 'postgresql'");
      for (const leg of legacyDbs) {
        await dbAsync.run(
          `INSERT INTO databases_postgres (name, host, port, db_name, db_user, password, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [leg.name, leg.host, leg.port || 5432, leg.db_name || 'postgres', leg.db_user || leg.username || 'postgres', leg.password, leg.created_at || new Date().toISOString()]
        );
        await dbAsync.run("DELETE FROM servers WHERE id = ?", [leg.id]);
      }
    } catch (e) {}

    // Auto-migrate legacy Storage records from servers table to object_storages
    try {
      const legacyStorages = await dbAsync.all("SELECT * FROM servers WHERE type = 'minio' OR type = 's3'");
      for (const leg of legacyStorages) {
        await dbAsync.run(
          `INSERT INTO object_storages (name, type, s3_endpoint, s3_access_key, s3_secret_key, s3_region, s3_bucket, port, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [leg.name, leg.type, leg.s3_endpoint || leg.host, leg.s3_access_key || leg.username, leg.s3_secret_key || leg.password, leg.s3_region || 'us-east-1', leg.s3_bucket || '', leg.port || 9000, leg.created_at || new Date().toISOString()]
        );
        await dbAsync.run("DELETE FROM servers WHERE id = ?", [leg.id]);
      }
    } catch (e) {}

    const serverCount = await dbAsync.get('SELECT COUNT(*) as count FROM servers');
    if (serverCount && serverCount.count === 0) {
      await dbAsync.run(
        `INSERT INTO servers (name, host, port, username, auth_type, is_local, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ['Host Server (Lokal)', '127.0.0.1', 22, 'local', 'local', 1, 'vps']
      );
    }
  } catch (err) {
    console.error('Database initialization error:', err.message);
  }
}

initDb();

module.exports = dbAsync;
module.exports.dbAsync = dbAsync;
module.exports.db = db;
