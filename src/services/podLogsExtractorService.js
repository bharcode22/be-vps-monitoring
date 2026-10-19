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

/**
 * Get daily aggregated session & user monitoring summary
 */
async function getSessionMonitoringSummary({ masterId, podId, dateFrom, dateTo, groupByPod = false }) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  // Fetch registered pods from SQLite to map pod_uuid to friendly pod_name
  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL ORDER BY name ASC');
  const podMap = {};
  servers.forEach((s) => {
    podMap[s.pod_uuid] = s.name || s.code;
  });

  const client = createMasterClient(master);
  await client.connect();

  try {
    let whereClauses = [];
    let params = [];
    let pIdx = 1;

    if (podId && podId !== 'ALL') {
      whereClauses.push(`pod_id = $${pIdx++}::uuid`);
      params.push(podId);
    }

    if (dateFrom) {
      whereClauses.push(`created_at >= $${pIdx++}::date`);
      params.push(dateFrom);
    }

    if (dateTo) {
      whereClauses.push(`created_at <= ($${pIdx++}::date + INTERVAL '1 day')`);
      params.push(dateTo);
    }

    const isGroupPod = groupByPod === true || groupByPod === 'true' || groupByPod === '1';

    if (isGroupPod && (!podId || podId === 'ALL')) {
      whereClauses.push(`pod_id IS NOT NULL`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    let selectSql = '';
    let groupSql = '';

    if (isGroupPod) {
      selectSql = `
        DATE(created_at AT TIME ZONE 'Asia/Jakarta') as raw_date,
        TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta', 'FMMonth DD, YYYY') as timestamp_session,
        pod_id,
        COUNT(DISTINCT user_id) as total_user,
        COUNT(*) as total_session
      `;
      groupSql = `GROUP BY raw_date, timestamp_session, pod_id HAVING COUNT(DISTINCT user_id) > 0 AND COUNT(*) > 0 ORDER BY raw_date DESC, total_session DESC`;
    } else {
      selectSql = `
        DATE(created_at AT TIME ZONE 'Asia/Jakarta') as raw_date,
        TO_CHAR(created_at AT TIME ZONE 'Asia/Jakarta', 'FMMonth DD, YYYY') as timestamp_session,
        COUNT(DISTINCT user_id) as total_user,
        COUNT(*) as total_session
      `;
      groupSql = `GROUP BY raw_date, timestamp_session HAVING COUNT(DISTINCT user_id) > 0 AND COUNT(*) > 0 ORDER BY raw_date DESC`;
    }

    const query = `
      SELECT ${selectSql}
      FROM play_sesion_detail
      ${whereSql}
      ${groupSql}
      LIMIT 100
    `;

    const res = await client.query(query, params);

    const rows = res.rows
      .map((r) => {
        const pId = r.pod_id || null;
        const isRegistered = Boolean(pId && podMap[pId]);
        const podName = isGroupPod
          ? (isRegistered ? podMap[pId] : null)
          : (pId ? (podMap[pId] || `${pId.substring(0, 8)}...`) : 'Semua POD');

        return {
          raw_date: r.raw_date,
          timestamp_session: r.timestamp_session,
          pod_id: pId,
          pod_name: podName,
          total_user: parseInt(r.total_user || '0', 10),
          total_session: parseInt(r.total_session || '0', 10)
        };
      })
      .filter((r) => {
        // Exclude empty data: zero user or zero session
        if (r.total_user <= 0 || r.total_session <= 0) return false;
        // When grouping by POD, exclude null pod_id or unregistered/unknown PODs
        if (isGroupPod && (!r.pod_id || !r.pod_name)) return false;
        return true;
      });

    return {
      masterId: master.id,
      masterName: master.name,
      groupByPod: isGroupPod,
      registeredPods: servers,
      totalRows: rows.length,
      rows
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Get detailed individual sessions for a selected date and/or POD
 */
async function getSessionMonitoringDetails({ masterId, podId, date, page = 1, limit = 50, search = '' }) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL');
  const podMap = {};
  servers.forEach((s) => {
    podMap[s.pod_uuid] = s.name || s.code;
  });

  const client = createMasterClient(master);
  await client.connect();

  try {
    let whereClauses = [];
    let params = [];
    let pIdx = 1;

    // Filter out rows where both song_title and session_name are empty, blank, or '-'
    whereClauses.push(`(
      (song_title IS NOT NULL AND TRIM(song_title) NOT IN ('', '-', 'undefined', 'null')) OR
      (session_name IS NOT NULL AND TRIM(session_name) NOT IN ('', '-', 'undefined', 'null'))
    )`);

    if (date) {
      whereClauses.push(`DATE(created_at AT TIME ZONE 'Asia/Jakarta') = $${pIdx++}::date`);
      params.push(date);
    }

    if (podId && podId !== 'ALL') {
      whereClauses.push(`pod_id = $${pIdx++}::uuid`);
      params.push(podId);
    }

    if (search && search.trim()) {
      whereClauses.push(`(session_name ILIKE $${pIdx} OR song_title ILIKE $${pIdx} OR session_type ILIKE $${pIdx})`);
      pIdx++;
      params.push(`%${search.trim()}%`);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const countRes = await client.query(`SELECT COUNT(*) AS total FROM play_sesion_detail ${whereSql}`, params);
    const totalRows = parseInt(countRes.rows[0]?.total || '0', 10);

    const safeLimit = Math.max(10, Math.min(200, Number(limit) || 50));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    const dataParams = [...params, safeLimit, offset];
    const dataQuery = `
      SELECT id, user_id, pod_id, session_name, song_title, duration, session_type, created_at
      FROM play_sesion_detail
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT $${pIdx++} OFFSET $${pIdx++}
    `;

    const dataRes = await client.query(dataQuery, dataParams);

    const rows = dataRes.rows.map((r) => {
      const pId = r.pod_id || null;
      return {
        id: r.id,
        user_id: r.user_id,
        pod_id: pId,
        pod_name: pId ? (podMap[pId] || `${pId.substring(0, 8)}...`) : 'Unknown POD',
        session_name: r.session_name || '-',
        song_title: r.song_title || '-',
        duration: r.duration || '-',
        session_type: r.session_type || '-',
        created_at: r.created_at
      };
    });

    return {
      totalRows,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(totalRows / safeLimit) || 1,
      rows
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Get comprehensive Experience & Therapy Insights (Top Songs, Per-POD, Hourly, Completion)
 */
async function getExperienceInsightsData({ masterId, podId, dateFrom, dateTo }) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL');
  const podMap = {};
  servers.forEach((s) => {
    podMap[s.pod_uuid] = s.name || s.code;
  });

  const client = createMasterClient(master);
  await client.connect();

  try {
    let whereClauses = [];
    let params = [];
    let pIdx = 1;

    if (podId && podId !== 'ALL') {
      whereClauses.push(`pod_id = $${pIdx++}::uuid`);
      params.push(podId);
    }

    if (dateFrom) {
      whereClauses.push(`created_at >= $${pIdx++}::date`);
      params.push(dateFrom);
    }

    if (dateTo) {
      whereClauses.push(`created_at <= ($${pIdx++}::date + INTERVAL '1 day')`);
      params.push(dateTo);
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // 1. Overall Experience KPIs
    const kpiQuery = `
      SELECT 
        COUNT(*) as total_records,
        COUNT(DISTINCT user_id) as total_users,
        COUNT(DISTINCT DATE(created_at)) as active_days,
        COUNT(*) FILTER (WHERE session_type = 'end-session') as completed_sessions,
        COUNT(*) FILTER (WHERE session_type LIKE 'play-session%') as started_sessions,
        COUNT(*) FILTER (WHERE session_type LIKE 'stop-session%') as stopped_sessions
      FROM play_sesion_detail
      ${whereSql}
    `;
    const kpiRes = await client.query(kpiQuery, params);
    const kpi = kpiRes.rows[0] || {};

    // 2. Top 10 Most Played Songs / Sessions (Excluding empty/null/blank titles)
    const songsQuery = `
      SELECT 
        COALESCE(NULLIF(TRIM(song_title), ''), NULLIF(TRIM(session_name), ''), '') as title,
        session_name,
        COUNT(*) as play_count,
        COUNT(DISTINCT user_id) as unique_users
      FROM play_sesion_detail
      ${whereSql ? whereSql + " AND" : "WHERE"} session_type IN ('play-session-experience', 'play-session-explore')
        AND TRIM(COALESCE(song_title, session_name, '')) NOT IN ('', '-', 'undefined', 'Unknown', 'null')
      GROUP BY title, session_name
      HAVING COUNT(*) > 0
      ORDER BY play_count DESC
      LIMIT 10
    `;
    const songsRes = await client.query(songsQuery, params);

    // 3. Per POD Activity Breakdown (Excluding null pod_id & unmapped pods)
    const podQuery = `
      SELECT 
        pod_id,
        COUNT(*) as total_sessions,
        COUNT(DISTINCT user_id) as total_users,
        COUNT(DISTINCT DATE(created_at)) as active_days
      FROM play_sesion_detail
      ${whereSql ? whereSql + " AND pod_id IS NOT NULL" : "WHERE pod_id IS NOT NULL"}
      GROUP BY pod_id
      HAVING COUNT(*) > 0 AND COUNT(DISTINCT user_id) > 0
      ORDER BY total_sessions DESC
    `;
    const podRes = await client.query(podQuery, params);
    const podBreakdown = podRes.rows
      .map((r) => {
        const pId = r.pod_id || null;
        const name = pId && podMap[pId] ? podMap[pId] : null;
        return {
          pod_id: pId,
          pod_name: name,
          total_sessions: parseInt(r.total_sessions || '0', 10),
          total_users: parseInt(r.total_users || '0', 10),
          active_days: parseInt(r.active_days || '0', 10)
        };
      })
      .filter((r) => r.pod_id && r.pod_name && r.total_sessions > 0);

    // 4. Hourly Distribution (24-hour histogram in Asia/Jakarta)
    const hourlyQuery = `
      SELECT 
        EXTRACT(HOUR FROM created_at AT TIME ZONE 'Asia/Jakarta')::int as hour,
        COUNT(*) as count
      FROM play_sesion_detail
      ${whereSql}
      GROUP BY hour
      ORDER BY hour ASC
    `;
    const hourlyRes = await client.query(hourlyQuery, params);

    const hourlyMap = {};
    hourlyRes.rows.forEach((r) => { hourlyMap[r.hour] = parseInt(r.count, 10); });
    const hourlyDistribution = Array.from({ length: 24 }, (_, h) => ({
      hour: h,
      label: `${String(h).padStart(2, '0')}:00`,
      count: hourlyMap[h] || 0
    }));

    // 5. Session Types Breakdown (Completion vs Early Stops)
    const typesQuery = `
      SELECT 
        session_type,
        COUNT(*) as count
      FROM play_sesion_detail
      ${whereSql}
      GROUP BY session_type
      ORDER BY count DESC
    `;
    const typesRes = await client.query(typesQuery, params);
    const totalTypeCount = typesRes.rows.reduce((acc, r) => acc + parseInt(r.count, 10), 0);
    const sessionTypes = typesRes.rows.map((r) => {
      const count = parseInt(r.count, 10);
      return {
        session_type: r.session_type,
        count,
        percentage: totalTypeCount > 0 ? Math.round((count / totalTypeCount) * 1000) / 10 : 0
      };
    });

    return {
      masterId: master.id,
      masterName: master.name,
      kpi: {
        totalRecords: parseInt(kpi.total_records || '0', 10),
        totalUsers: parseInt(kpi.total_users || '0', 10),
        activeDays: parseInt(kpi.active_days || '0', 10),
        startedSessions: parseInt(kpi.started_sessions || '0', 10),
        completedSessions: parseInt(kpi.completed_sessions || '0', 10),
        stoppedSessions: parseInt(kpi.stopped_sessions || '0', 10),
        completionRate: parseInt(kpi.started_sessions || '0', 10) > 0
          ? Math.round((parseInt(kpi.completed_sessions || '0', 10) / parseInt(kpi.started_sessions || '0', 10)) * 100)
          : 100
      },
      topSongs: songsRes.rows
        .map((r) => ({
          title: r.title,
          session_name: r.session_name || '-',
          play_count: parseInt(r.play_count, 10),
          unique_users: parseInt(r.unique_users, 10)
        }))
        .filter((r) => r.title && !['', '-', 'undefined', 'Unknown', 'null'].includes(r.title.trim())),
      podBreakdown,
      hourlyDistribution,
      sessionTypes
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Get preview of orphan/unregistered pod data in Master DB based on local servers table
 */
async function getOrphanCleanupPreview({ masterId }) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL');
  const validUuids = servers.map((s) => s.pod_uuid).filter(Boolean);

  const client = createMasterClient(master);
  await client.connect();

  try {
    let playNullCount = 0;
    let playUnregisteredCount = 0;
    let playOrphanPods = [];

    let authNullCount = 0;
    let authUnregisteredCount = 0;
    let authOrphanPods = [];

    let logsNullCount = 0;
    let logsUnregisteredCount = 0;
    let logsOrphanPods = [];

    const uuidIn = validUuids.map((u) => `'${u}'`).join(', ');

    if (validUuids.length > 0) {
      // 1. play_sesion_detail
      const playNullRes = await client.query('SELECT COUNT(*) AS count FROM play_sesion_detail WHERE pod_id IS NULL');
      playNullCount = parseInt(playNullRes.rows[0]?.count || '0', 10);

      const playUnregRes = await client.query(`SELECT COUNT(*) AS count FROM play_sesion_detail WHERE pod_id IS NOT NULL AND pod_id NOT IN (${uuidIn})`);
      playUnregisteredCount = parseInt(playUnregRes.rows[0]?.count || '0', 10);

      const playPodsRes = await client.query(`SELECT pod_id, COUNT(*) as count FROM play_sesion_detail WHERE pod_id IS NULL OR pod_id NOT IN (${uuidIn}) GROUP BY pod_id`);
      playOrphanPods = playPodsRes.rows.map((r) => ({ pod_id: r.pod_id, count: parseInt(r.count, 10) }));

      // 2. auth_detail
      const authNullRes = await client.query('SELECT COUNT(*) AS count FROM auth_detail WHERE pod_id IS NULL');
      authNullCount = parseInt(authNullRes.rows[0]?.count || '0', 10);

      const authUnregRes = await client.query(`SELECT COUNT(*) AS count FROM auth_detail WHERE pod_id IS NOT NULL AND pod_id NOT IN (${uuidIn})`);
      authUnregisteredCount = parseInt(authUnregRes.rows[0]?.count || '0', 10);

      const authPodsRes = await client.query(`SELECT pod_id, COUNT(*) as count FROM auth_detail WHERE pod_id IS NULL OR pod_id NOT IN (${uuidIn}) GROUP BY pod_id`);
      authOrphanPods = authPodsRes.rows.map((r) => ({ pod_id: r.pod_id, count: parseInt(r.count, 10) }));

      // 3. pod_logs (Only truly orphan raw logs that do NOT have valid registered sessions attached)
      const logsOrphanCondition = `
        (pl.pod_id IS NULL OR pl.pod_id NOT IN (${uuidIn}))
        AND NOT EXISTS (
          SELECT 1 FROM pod_logs_extracted ple2
          JOIN play_sesion_detail psd ON psd.fk_pod_logs_extracted = ple2.id
          WHERE ple2.fk_pod_logs = pl.id
            AND psd.pod_id IN (${uuidIn})
        )
        AND NOT EXISTS (
          SELECT 1 FROM pod_logs_extracted ple2
          JOIN auth_detail ad ON ad.fk_pod_logs_extracted = ple2.id
          WHERE ple2.fk_pod_logs = pl.id
            AND ad.pod_id IN (${uuidIn})
        )
      `;

      const logsNullRes = await client.query(`SELECT COUNT(*) AS count FROM pod_logs pl WHERE pl.pod_id IS NULL AND ${logsOrphanCondition}`);
      logsNullCount = parseInt(logsNullRes.rows[0]?.count || '0', 10);

      const logsUnregRes = await client.query(`SELECT COUNT(*) AS count FROM pod_logs pl WHERE pl.pod_id IS NOT NULL AND ${logsOrphanCondition}`);
      logsUnregisteredCount = parseInt(logsUnregRes.rows[0]?.count || '0', 10);

      const logsPodsRes = await client.query(`SELECT pl.pod_id, COUNT(*) as count FROM pod_logs pl WHERE ${logsOrphanCondition} GROUP BY pl.pod_id`);
      logsOrphanPods = logsPodsRes.rows.map((r) => ({ pod_id: r.pod_id, count: parseInt(r.count, 10) }));
    }

    // Merge distinct orphan UUIDs across tables
    const orphanMap = new Map();
    [...playOrphanPods, ...authOrphanPods, ...logsOrphanPods].forEach((item) => {
      const key = item.pod_id || 'NULL_POD_ID';
      const prev = orphanMap.get(key) || { pod_id: item.pod_id, play_count: 0, auth_count: 0, log_count: 0 };
      orphanMap.set(key, prev);
    });
    playOrphanPods.forEach((p) => {
      const k = p.pod_id || 'NULL_POD_ID';
      if (orphanMap.has(k)) orphanMap.get(k).play_count = p.count;
    });
    authOrphanPods.forEach((p) => {
      const k = p.pod_id || 'NULL_POD_ID';
      if (orphanMap.has(k)) orphanMap.get(k).auth_count = p.count;
    });
    logsOrphanPods.forEach((p) => {
      const k = p.pod_id || 'NULL_POD_ID';
      if (orphanMap.has(k)) orphanMap.get(k).log_count = p.count;
    });

    return {
      masterId: master.id,
      masterName: master.name,
      registeredServersCount: servers.length,
      registeredPods: servers,
      summary: {
        playSessionsOrphanTotal: playNullCount + playUnregisteredCount,
        playSessionsNull: playNullCount,
        playSessionsUnregistered: playUnregisteredCount,

        authOrphanTotal: authNullCount + authUnregisteredCount,
        authNull: authNullCount,
        authUnregistered: authUnregisteredCount,

        rawLogsOrphanTotal: logsNullCount + logsUnregisteredCount,
        rawLogsNull: logsNullCount,
        rawLogsUnregistered: logsUnregisteredCount,

        totalExtractedOrphans: (playNullCount + playUnregisteredCount) + (authNullCount + authUnregisteredCount)
      },
      orphanPodsList: Array.from(orphanMap.values())
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Execute cleanup of orphan / unregistered pod data from Master DB in a transaction
 */
async function executeOrphanCleanup({
  masterId,
  cleanExtracted = true,
  cleanRawLogs = false
}) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL');
  const validUuids = servers.map((s) => s.pod_uuid).filter(Boolean);

  if (validUuids.length === 0) {
    throw new Error('Tidak ada unit POD terdaftar di tabel servers lokal. Pembersihan dibatalkan demi keamanan.');
  }

  const uuidIn = validUuids.map((u) => `'${u}'`).join(', ');

  const client = createMasterClient(master);
  await client.connect();

  let deletedPlay = 0;
  let deletedAuth = 0;
  let deletedExtractedParents = 0;
  let deletedRawLogs = 0;

  try {
    await client.query('BEGIN');

    // 1. Clean extracted details
    if (cleanExtracted || cleanRawLogs) {
      // Delete orphan play_sesion_detail
      const delPlayRes = await client.query(`
        DELETE FROM play_sesion_detail
        WHERE pod_id IS NULL OR pod_id NOT IN (${uuidIn})
      `);
      deletedPlay = delPlayRes.rowCount || 0;

      // Delete orphan auth_detail
      const delAuthRes = await client.query(`
        DELETE FROM auth_detail
        WHERE pod_id IS NULL OR pod_id NOT IN (${uuidIn})
      `);
      deletedAuth = delAuthRes.rowCount || 0;

      // Clean up orphaned pod_logs_extracted rows that now have no children
      const delExtractedRes = await client.query(`
        DELETE FROM pod_logs_extracted ple
        WHERE NOT EXISTS (SELECT 1 FROM play_sesion_detail psd WHERE psd.fk_pod_logs_extracted = ple.id)
          AND NOT EXISTS (SELECT 1 FROM auth_detail ad WHERE ad.fk_pod_logs_extracted = ple.id)
          AND EXISTS (
            SELECT 1 FROM pod_logs pl
            WHERE pl.id = ple.fk_pod_logs
              AND (pl.pod_id IS NULL OR pl.pod_id NOT IN (${uuidIn}))
          )
      `);
      deletedExtractedParents = delExtractedRes.rowCount || 0;
    }

    // 2. Clean raw pod_logs if requested
    if (cleanRawLogs) {
      // Truly orphan raw logs subquery (protects raw logs that produced valid sessions for registered PODs like POD 35)
      const orphanRawLogsSubquery = `
        SELECT pl.id FROM pod_logs pl
        WHERE (pl.pod_id IS NULL OR pl.pod_id NOT IN (${uuidIn}))
          AND NOT EXISTS (
            SELECT 1 FROM pod_logs_extracted ple2
            JOIN play_sesion_detail psd ON psd.fk_pod_logs_extracted = ple2.id
            WHERE ple2.fk_pod_logs = pl.id
              AND psd.pod_id IN (${uuidIn})
          )
          AND NOT EXISTS (
            SELECT 1 FROM pod_logs_extracted ple2
            JOIN auth_detail ad ON ad.fk_pod_logs_extracted = ple2.id
            WHERE ple2.fk_pod_logs = pl.id
              AND ad.pod_id IN (${uuidIn})
          )
      `;

      // 2a. Delete any child play_sesion_detail / auth_detail linked to these logs first
      await client.query(`
        DELETE FROM play_sesion_detail
        WHERE fk_pod_logs_extracted IN (
          SELECT ple.id FROM pod_logs_extracted ple WHERE ple.fk_pod_logs IN (${orphanRawLogsSubquery})
        )
      `);
      await client.query(`
        DELETE FROM auth_detail
        WHERE fk_pod_logs_extracted IN (
          SELECT ple.id FROM pod_logs_extracted ple WHERE ple.fk_pod_logs IN (${orphanRawLogsSubquery})
        )
      `);

      // 2b. Delete pod_logs_extracted pointing to these logs
      await client.query(`
        DELETE FROM pod_logs_extracted
        WHERE fk_pod_logs IN (${orphanRawLogsSubquery})
      `);

      // 2c. Delete the truly orphan raw logs
      const delLogsRes = await client.query(`
        DELETE FROM pod_logs
        WHERE id IN (${orphanRawLogsSubquery})
      `);
      deletedRawLogs = delLogsRes.rowCount || 0;
    }

    await client.query('COMMIT');

    return {
      success: true,
      masterId: master.id,
      masterName: master.name,
      deleted: {
        playSessions: deletedPlay,
        auth: deletedAuth,
        extractedParents: deletedExtractedParents,
        rawLogs: deletedRawLogs,
        total: deletedPlay + deletedAuth + deletedRawLogs
      }
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { }
    throw err;
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

/**
 * Fetch detailed paginated orphan records for inspection prior to cleanup
 */
async function getOrphanCleanupRecords({
  masterId,
  table = 'play_sesion_detail',
  page = 1,
  limit = 20,
  search = ''
}) {
  if (!masterId) throw new Error('masterId wajib disertakan.');

  const master = await dbAsync.get('SELECT * FROM databases_postgres WHERE id = ?', [masterId]);
  if (!master) throw new Error('Master DB tidak ditemukan.');

  const servers = await dbAsync.all('SELECT id, name, code, pod_uuid FROM servers WHERE pod_uuid IS NOT NULL');
  const validUuids = servers.map((s) => s.pod_uuid).filter(Boolean);

  if (validUuids.length === 0) {
    return { table, totalRows: 0, page: 1, limit, rows: [] };
  }

  const uuidIn = validUuids.map((u) => `'${u}'`).join(', ');

  const client = createMasterClient(master);
  await client.connect();

  try {
    const safeLimit = Math.max(5, Math.min(100, Number(limit) || 20));
    const safePage = Math.max(1, Number(page) || 1);
    const offset = (safePage - 1) * safeLimit;

    let targetTable = 'play_sesion_detail';
    let selectFields = '';
    let searchCondition = '';

    if (table === 'auth_detail') {
      targetTable = 'auth_detail';
      selectFields = 'id, user_id, pod_id, activity_type, "user", code, place, type, value, created_at';
      if (search && search.trim()) {
        const q = search.trim().replace(/'/g, "''");
        searchCondition = `AND ("user" ILIKE '%${q}%' OR activity_type ILIKE '%${q}%')`;
      }
    } else if (table === 'pod_logs') {
      targetTable = 'pod_logs';
      selectFields = 'id, user_id, pod_id, code, value, activity_type, created_at';
      if (search && search.trim()) {
        const q = search.trim().replace(/'/g, "''");
        searchCondition = `AND (value ILIKE '%${q}%' OR activity_type ILIKE '%${q}%' OR code ILIKE '%${q}%')`;
      }
    } else {
      // Default: play_sesion_detail
      targetTable = 'play_sesion_detail';
      selectFields = 'id, user_id, pod_id, session_name, song_title, duration, session_type, created_at';
      if (search && search.trim()) {
        const q = search.trim().replace(/'/g, "''");
        searchCondition = `AND (session_name ILIKE '%${q}%' OR song_title ILIKE '%${q}%' OR session_type ILIKE '%${q}%')`;
      }
    }

    let whereSql = '';
    if (table === 'pod_logs') {
      whereSql = `
        WHERE (pod_id IS NULL OR pod_id NOT IN (${uuidIn}))
          AND NOT EXISTS (
            SELECT 1 FROM pod_logs_extracted ple2
            JOIN play_sesion_detail psd ON psd.fk_pod_logs_extracted = ple2.id
            WHERE ple2.fk_pod_logs = pod_logs.id
              AND psd.pod_id IN (${uuidIn})
          )
          AND NOT EXISTS (
            SELECT 1 FROM pod_logs_extracted ple2
            JOIN auth_detail ad ON ad.fk_pod_logs_extracted = ple2.id
            WHERE ple2.fk_pod_logs = pod_logs.id
              AND ad.pod_id IN (${uuidIn})
          )
          ${searchCondition}
      `;
    } else {
      whereSql = `WHERE (pod_id IS NULL OR pod_id NOT IN (${uuidIn})) ${searchCondition}`;
    }

    const countRes = await client.query(`SELECT COUNT(*) AS total FROM ${targetTable} ${whereSql}`);
    const totalRows = parseInt(countRes.rows[0]?.total || '0', 10);

    const query = `
      SELECT ${selectFields}
      FROM ${targetTable}
      ${whereSql}
      ORDER BY created_at DESC
      LIMIT ${safeLimit} OFFSET ${offset}
    `;

    const dataRes = await client.query(query);

    const rows = dataRes.rows.map((r) => ({
      ...r,
      orphan_reason: !r.pod_id ? 'pod_id Kosong (NULL)' : 'UUID Tidak Terdaftar'
    }));

    return {
      table: targetTable,
      totalRows,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(totalRows / safeLimit) || 1,
      rows
    };
  } finally {
    try { await client.end(); } catch (_) { }
  }
}

module.exports = {
  getMasterDatabases,
  getExtractorStats,
  executeExtraction,
  getSessionMonitoringSummary,
  getSessionMonitoringDetails,
  getExperienceInsightsData,
  getOrphanCleanupPreview,
  getOrphanCleanupRecords,
  executeOrphanCleanup,
  sanitizeUuid,
  PLAY_SESSION_TYPES,
  AUTH_TYPES
};
