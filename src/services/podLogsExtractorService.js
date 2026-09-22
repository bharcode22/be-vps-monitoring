const { Client } = require('pg');
const { dbAsync } = require('./db');
const { decrypt } = require('../utils/crypto');

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const PLAY_SESSION_TYPES = [
  'play-session-experience',
  'play-session-explore',
  'end-session',
  'stop-session-experience',
  'stop-session-explore'
];

const AUTH_TYPES = ['login', 'logout'];

/**
 * Sanitize UUID string for PostgreSQL UUID columns
 */
function sanitizeUuid(val) {
  if (!val || typeof val !== 'string') return null;
  const trimmed = val.trim();
  return UUID_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * Create connection to specified Master PostgreSQL DB
 */
function createMasterClient(masterRecord) {
  const host = masterRecord.host || 'localhost';
  const isCloudDb = host.includes('rds.amazonaws.com') || host.includes('neon.tech') || host.includes('supabase');
  const user = masterRecord.db_user || 'postgres';
  const pass = decrypt(masterRecord.password) || '';
  const port = masterRecord.port || 5432;
  const dbName = masterRecord.db_name || 'postgres';

  return new Client({
    user,
    password: pass,
    host,
    port,
    database: dbName,
    ssl: isCloudDb ? { rejectUnauthorized: false } : false,
    connectionTimeoutMillis: 10000,
    statement_timeout: 120000
  });
}

/**
 * Get available Master PostgreSQL databases
 */
async function getMasterDatabases() {
  try {
    return await dbAsync.all('SELECT id, name, host, port, db_name, db_user FROM databases_postgres ORDER BY id ASC');
  } catch (err) {
    console.error('Error fetching master databases:', err.message);
    return [];
  }
}

/**
 * Get extraction status statistics from Master DB
 */
async function getExtractorStats(masterId) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  try {
    const totalLogsRes = await client.query('SELECT COUNT(*) AS count FROM pod_logs');
    const extractedRes = await client.query('SELECT COUNT(*) AS count FROM pod_logs_extracted');
    const unextractedRes = await client.query(`
      SELECT COUNT(*) AS count 
      FROM pod_logs pl 
      WHERE NOT EXISTS (SELECT 1 FROM pod_logs_extracted ple WHERE ple.fk_pod_logs = pl.id)
    `);
    const sessionsRes = await client.query('SELECT COUNT(*) AS count FROM play_sesion_detail');
    const authRes = await client.query('SELECT COUNT(*) AS count FROM auth_detail');
    const activityRes = await client.query(`
      SELECT activity_type, COUNT(*) AS count 
      FROM pod_logs 
      GROUP BY activity_type 
      ORDER BY count DESC
    `);
    const latestLogRes = await client.query('SELECT MAX(created_at) AS latest, MIN(created_at) AS earliest FROM pod_logs');

    // Fetch registered pods from servers table for friendly dropdown filter
    const registeredPods = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL ORDER BY name ASC');

    return {
      masterId: master.id,
      masterName: master.name,
      totalPodLogs: parseInt(totalLogsRes.rows[0]?.count || '0', 10),
      totalExtracted: parseInt(extractedRes.rows[0]?.count || '0', 10),
      unextractedCount: parseInt(unextractedRes.rows[0]?.count || '0', 10),
      totalPlaySessions: parseInt(sessionsRes.rows[0]?.count || '0', 10),
      totalAuthDetails: parseInt(authRes.rows[0]?.count || '0', 10),
      activityTypeBreakdown: activityRes.rows.map(r => ({
        activityType: r.activity_type || 'UNKNOWN',
        count: parseInt(r.count, 10)
      })),
      registeredPods: registeredPods || [],
      earliestLogAt: latestLogRes.rows[0]?.earliest || null,
      latestLogAt: latestLogRes.rows[0]?.latest || null
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Process a single log record following user's extractors logic
 */
async function processSingleLog(client, log) {
  let parsedData = {};
  try {
    parsedData = log.data ? (typeof log.data === 'object' ? log.data : JSON.parse(log.data)) : {};
  } catch (_) {
    parsedData = {};
  }

  // 1. Buat atau ambil extracted
  const existingExtractedRes = await client.query(
    'SELECT id FROM pod_logs_extracted WHERE fk_pod_logs = $1 LIMIT 1',
    [log.id]
  );

  let extractedId = null;
  let isNewExtracted = false;

  if (existingExtractedRes.rows.length > 0) {
    extractedId = existingExtractedRes.rows[0].id;
  } else {
    const insertExtractedRes = await client.query(
      'INSERT INTO pod_logs_extracted (fk_pod_logs) VALUES ($1) RETURNING id',
      [log.id]
    );
    extractedId = insertExtractedRes.rows[0].id;
    isNewExtracted = true;
  }

  let createdSession = false;
  let createdAuth = false;
  let skipped = true;

  const validUserId = sanitizeUuid(log.user_id);
  const validPodId = sanitizeUuid(log.pod_id);

  // 2. Handler untuk PLAY SESSION
  if (PLAY_SESSION_TYPES.includes(log.activity_type)) {
    const songTitle = parsedData.song || null;
    const sessionName = log.value || null;
    const code = log.code || null;

    const existingDetailRes = await client.query(`
      SELECT id FROM play_sesion_detail
      WHERE fk_pod_logs_extracted = $1
        AND session_type = $2
        AND session_name IS NOT DISTINCT FROM $3
        AND song_title IS NOT DISTINCT FROM $4
        AND code IS NOT DISTINCT FROM $5
      LIMIT 1
    `, [extractedId, log.activity_type, sessionName, songTitle, code]);

    if (existingDetailRes.rows.length === 0) {
      const durationStr = (parsedData.duration !== undefined && parsedData.duration !== null)
        ? String(parsedData.duration)
        : null;
      const captionStr = parsedData.caption || null;

      await client.query(`
        INSERT INTO play_sesion_detail (
          fk_pod_logs_extracted,
          user_id,
          pod_id,
          session_type,
          session_name,
          song_title,
          duration,
          caption,
          code,
          activity_key,
          sub_ativity_key,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        extractedId,
        validUserId,
        validPodId,
        log.activity_type,
        sessionName,
        songTitle,
        durationStr,
        captionStr,
        code,
        log.activity_key || null,
        log.sub_ativity_key || null,
        log.created_at || new Date()
      ]);

      createdSession = true;
      skipped = false;
    }
  }

  // 3. Handler untuk LOGIN/LOGOUT
  if (AUTH_TYPES.includes(log.activity_type)) {
    const userVal = log.value || null;
    const code = log.code || null;

    const existingAuthRes = await client.query(`
      SELECT id FROM auth_detail
      WHERE fk_pod_logs_extracted = $1
        AND activity_type = $2
        AND "user" IS NOT DISTINCT FROM $3
        AND code IS NOT DISTINCT FROM $4
      LIMIT 1
    `, [extractedId, log.activity_type, userVal, code]);

    if (existingAuthRes.rows.length === 0) {
      const place = parsedData.place || null;
      const subActivityKey = parsedData.sub_activity_key || null;
      const subValue = parsedData.sub_value !== undefined ? (typeof parsedData.sub_value === 'object' ? JSON.stringify(parsedData.sub_value) : String(parsedData.sub_value)) : null;
      const subValue2 = parsedData.sub_value2 !== undefined ? (typeof parsedData.sub_value2 === 'object' ? JSON.stringify(parsedData.sub_value2) : String(parsedData.sub_value2)) : null;
      const parsedType = parsedData.type || null;
      const parsedValue = parsedData.value !== undefined ? (typeof parsedData.value === 'object' ? JSON.stringify(parsedData.value) : String(parsedData.value)) : null;

      await client.query(`
        INSERT INTO auth_detail (
          fk_pod_logs_extracted,
          user_id,
          pod_id,
          activity_type,
          "user",
          code,
          activity_key,
          sub_ativity_key,
          created_at,
          place,
          sub_activity_key,
          sub_value,
          sub_value2,
          type,
          value
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
      `, [
        extractedId,
        validUserId,
        validPodId,
        log.activity_type,
        userVal,
        code,
        log.activity_key || null,
        log.sub_ativity_key || null,
        log.created_at || new Date(),
        place,
        subActivityKey,
        subValue,
        subValue2,
        parsedType,
        parsedValue
      ]);

      createdAuth = true;
      skipped = false;
    }
  }

  return {
    isNewExtracted,
    createdSession,
    createdAuth,
    skipped: skipped && !isNewExtracted
  };
}

/**
 * Execute extraction across matching pod_logs in batches
 */
async function executeExtraction({
  masterId,
  scope = 'UNEXTRACTED_ONLY',
  batchSize = 500,
  dateFrom = null,
  dateTo = null,
  podCode = null,
  activityType = null,
  maxLogs = 0,
  onProgress = null
}) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const client = createMasterClient(master);
  await client.connect();

  const startTime = Date.now();
  let processed = 0;
  let createdExtractedCount = 0;
  let createdSessionCount = 0;
  let createdAuthCount = 0;
  let skippedCount = 0;

  try {
    // Build SQL query according to selected scope & filters
    let whereClauses = [];
    let params = [];
    let pIdx = 1;

    if (scope === 'UNEXTRACTED_ONLY') {
      whereClauses.push(`NOT EXISTS (SELECT 1 FROM pod_logs_extracted ple WHERE ple.fk_pod_logs = pl.id)`);
    }

    if (dateFrom) {
      whereClauses.push(`pl.created_at >= $${pIdx++}`);
      params.push(new Date(dateFrom));
    }

    if (dateTo) {
      whereClauses.push(`pl.created_at <= $${pIdx++}`);
      params.push(new Date(dateTo));
    }

    if (podCode && podCode !== 'ALL') {
      whereClauses.push(`(pl.code = $${pIdx} OR pl.pod_id = $${pIdx})`);
      pIdx++;
      params.push(podCode);
    }

    if (activityType && activityType !== 'ALL') {
      whereClauses.push(`pl.activity_type = $${pIdx++}`);
      params.push(activityType);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Count matching rows
    const countSql = `SELECT COUNT(*) AS total FROM pod_logs pl ${whereSql}`;
    const countRes = await client.query(countSql, params);
    let totalLogs = parseInt(countRes.rows[0]?.total || '0', 10);

    if (maxLogs && maxLogs > 0 && maxLogs < totalLogs) {
      totalLogs = maxLogs;
    }

    if (onProgress) {
      onProgress({
        status: 'STARTING',
        totalLogs,
        processed: 0,
        percentage: 0,
        message: `Memulai ekstraksi data dari ${totalLogs} baris pod_logs...`
      });
    }

    if (totalLogs === 0) {
      return {
        success: true,
        masterName: master.name,
        totalLogs: 0,
        processed: 0,
        createdExtractedCount: 0,
        createdSessionCount: 0,
        createdAuthCount: 0,
        skippedCount: 0,
        durationSeconds: Math.round((Date.now() - startTime) / 1000)
      };
    }

    // Process in batches
    const effectiveBatchSize = Math.max(50, Math.min(2000, Number(batchSize) || 500));
    let offset = 0;

    while (processed < totalLogs) {
      const currentLimit = Math.min(effectiveBatchSize, totalLogs - processed);

      // When UNEXTRACTED_ONLY, offset stays 0 because processed items exit the NOT EXISTS filter
      const currentOffset = (scope === 'UNEXTRACTED_ONLY') ? 0 : offset;

      const batchParams = [...params, currentLimit, currentOffset];
      const batchSql = `
        SELECT pl.id, pl.pod_id, pl.user_id, pl.code, pl.value, pl.activity_type, pl.data, pl.activity_key, pl.sub_ativity_key, pl.created_at
        FROM pod_logs pl
        ${whereSql}
        ORDER BY pl.created_at ASC, pl.id ASC
        LIMIT $${batchParams.length - 1} OFFSET $${batchParams.length}
      `;

      const batchRes = await client.query(batchSql, batchParams);
      if (batchRes.rows.length === 0) break;

      // Wrap batch inside a transaction for atomicity & performance
      await client.query('BEGIN');
      try {
        for (const row of batchRes.rows) {
          const res = await processSingleLog(client, row);
          if (res.isNewExtracted) createdExtractedCount++;
          if (res.createdSession) createdSessionCount++;
          if (res.createdAuth) createdAuthCount++;
          if (res.skipped) skippedCount++;

          processed++;
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }

      if (scope !== 'UNEXTRACTED_ONLY') {
        offset += batchRes.rows.length;
      }

      const pct = Math.min(100, Math.round((processed / totalLogs) * 100));
      const elapsedSec = Math.max(0.1, (Date.now() - startTime) / 1000);
      const rate = Math.round(processed / elapsedSec);

      if (onProgress) {
        onProgress({
          status: 'RUNNING',
          totalLogs,
          processed,
          createdExtractedCount,
          createdSessionCount,
          createdAuthCount,
          skippedCount,
          percentage: pct,
          rate,
          message: `Batch selesai: ${processed}/${totalLogs} baris (${pct}%) • ${rate} log/dtk • +${createdSessionCount} sesi, +${createdAuthCount} auth`
        });
      }
    }

    const durationSeconds = Math.round((Date.now() - startTime) / 1000);

    if (onProgress) {
      onProgress({
        status: 'FINISHED',
        totalLogs,
        processed,
        createdExtractedCount,
        createdSessionCount,
        createdAuthCount,
        skippedCount,
        percentage: 100,
        durationSeconds,
        message: `Ekstraksi selesai! ${processed} log diproses dalam ${durationSeconds} detik.`
      });
    }

    return {
      success: true,
      masterName: master.name,
      totalLogs,
      processed,
      createdExtractedCount,
      createdSessionCount,
      createdAuthCount,
      skippedCount,
      durationSeconds
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

module.exports = {
  getMasterDatabases,
  getExtractorStats,
  executeExtraction,
  sanitizeUuid,
  PLAY_SESSION_TYPES,
  AUTH_TYPES
};
