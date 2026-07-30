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
        ram_usage REAL DEFAULT 0,
        ram_used_mb REAL DEFAULT 0,
        ram_total_mb REAL DEFAULT 0,
        bandwidth_rx_speed REAL DEFAULT 0,
        bandwidth_tx_speed REAL DEFAULT 0,
        disk_usage REAL DEFAULT 0,
        gpu_usage REAL DEFAULT 0,
        gpu_memory_usage REAL DEFAULT 0,
        gpu_name TEXT DEFAULT '',
        gpu_temp REAL DEFAULT 0,
        ping_ms REAL DEFAULT 0,
        status TEXT DEFAULT 'online',
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
      );
    `);

    // Migration for existing tables
    try {
      await dbAsync.exec("ALTER TABLE servers ADD COLUMN type TEXT DEFAULT 'vps'");
    } catch (e) { }

    try {
      await dbAsync.exec("ALTER TABLE servers ADD COLUMN pod_version TEXT DEFAULT ''");
    } catch (e) { }

    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_usage REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_memory_usage REAL DEFAULT 0"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_name TEXT DEFAULT ''"); } catch (e) { }
    try { await dbAsync.exec("ALTER TABLE metrics_history ADD COLUMN gpu_temp REAL DEFAULT 0"); } catch (e) { }

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
