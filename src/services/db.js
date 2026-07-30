const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '../../data/monitoring.db');
const dataDir = path.dirname(dbPath);

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Initialize Tables
db.exec(`
  CREATE TABLE IF NOT EXISTS servers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    host TEXT NOT NULL,
    port INTEGER DEFAULT 22,
    username TEXT DEFAULT 'root',
    auth_type TEXT DEFAULT 'password', -- 'password' | 'key' | 'local'
    password TEXT,
    private_key TEXT,
    is_local INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS metrics_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    server_id INTEGER NOT NULL,
    cpu_usage REAL DEFAULT 0,
    ram_usage REAL DEFAULT 0,
    ram_used_mb REAL DEFAULT 0,
    ram_total_mb REAL DEFAULT 0,
    bandwidth_rx_speed REAL DEFAULT 0, -- KB/s
    bandwidth_tx_speed REAL DEFAULT 0, -- KB/s
    disk_usage REAL DEFAULT 0,
    ping_ms REAL DEFAULT 0,
    status TEXT DEFAULT 'online',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(server_id) REFERENCES servers(id) ON DELETE CASCADE
  );
`);

// Seed local server if DB is empty
const serverCount = db.prepare('SELECT COUNT(*) as count FROM servers').get();
if (serverCount.count === 0) {
  db.prepare(`
    INSERT INTO servers (name, host, port, username, auth_type, is_local)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('Host Server (Lokal)', '127.0.0.1', 22, 'local', 'local', 1);
}

module.exports = db;
