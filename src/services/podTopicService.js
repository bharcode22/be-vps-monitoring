const { Client } = require('pg');
const dbAsync = require('./db');
const { executeSshCommand } = require('../utils/sshExecutor');

const DB_USER = process.env.POD_DB_USER;
const DB_PASS = process.env.POD_DB_PASS;
const DB_NAME = process.env.POD_DB_NAME;
const DB_PORT = parseInt(process.env.POD_DB_PORT, 10);

/**
 * Build PostgreSQL connection string for a POD host
 */
function getPodDbUrl(host) {
  const encUser = encodeURIComponent(DB_USER);
  const encPass = encodeURIComponent(DB_PASS);
  return `postgresql://${encUser}:${encPass}@${host}:${DB_PORT}/${DB_NAME}?schema=public`;
}

/**
 * Fetch pod_topics and socket_topics from a POD database (Direct PG with SSH Fallback)
 * Supports both plural (pod_topics/socket_topics) and singular (pod_topic/socket_topic) tables.
 * @param {Object} podServer - Server record from database
 * @returns {Promise<{ podTopics: Array, socketTopics: Array, method: string, success: boolean, error?: string }>}
 */
async function fetchTopicsFromPod(podServer) {
  const host = podServer.host;

  // 1. Attempt Direct PostgreSQL Connection (Super fast, <100ms)
  try {
    const client = new Client({
      connectionString: getPodDbUrl(host),
      connectionTimeoutMillis: 3000,
      statement_timeout: 4000
    });

    await client.connect();

    let podTopics = [];
    let socketTopics = [];

    // Query pod_topics (plural first, then singular fallback)
    try {
      const resPod = await client.query('SELECT * FROM public.pod_topics ORDER BY id ASC');
      podTopics = resPod.rows || [];
    } catch (errPodPlural) {
      try {
        const resPodSingular = await client.query('SELECT * FROM public.pod_topic ORDER BY id ASC');
        podTopics = resPodSingular.rows || [];
      } catch (errPod) {
        console.warn(`pod_topics query warning on ${podServer.name}:`, errPod.message);
      }
    }

    // Query socket_topics (plural first, then singular fallback)
    try {
      const resSocket = await client.query('SELECT * FROM public.socket_topics ORDER BY id ASC');
      socketTopics = resSocket.rows || [];
    } catch (errSocketPlural) {
      try {
        const resSocketSingular = await client.query('SELECT * FROM public.socket_topic ORDER BY id ASC');
        socketTopics = resSocketSingular.rows || [];
      } catch (errSocket) {
        console.warn(`socket_topics query warning on ${podServer.name}:`, errSocket.message);
      }
    }

    await client.end();

    return {
      serverId: podServer.id,
      serverName: podServer.name,
      host: podServer.host,
      podTopics,
      socketTopics,
      method: 'direct_postgres',
      success: true
    };
  } catch (directErr) {
    console.warn(`Direct PG failed for ${podServer.name}: ${directErr.message}. Attempting SSH Fallback...`);
  }

  // 2. SSH Fallback execution using psql with multi-method resolution
  try {
    const fetchCmd = `
      export PGPASSWORD='${DB_PASS}'
      run_q() {
        local query="$1"
        local out=""
        out=$(psql -U ${DB_USER} -h 127.0.0.1 -d ${DB_NAME} -t -A -c "$query" 2>/dev/null)
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          out=$(psql -U ${DB_USER} -d ${DB_NAME} -t -A -c "$query" 2>/dev/null)
        fi
        if [ -z "$out" ] || [ "$out" = "[]" ]; then
          out=$(sudo -u postgres psql -d ${DB_NAME} -t -A -c "$query" 2>/dev/null)
        fi
        echo "$out"
      }

      POD_JSON=$(run_q "SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT * FROM public.pod_topics ORDER BY id ASC) t;")
      if [ -z "$POD_JSON" ] || [ "$POD_JSON" = "[]" ]; then
        POD_JSON=$(run_q "SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT * FROM public.pod_topic ORDER BY id ASC) t;")
      fi

      SOCKET_JSON=$(run_q "SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT * FROM public.socket_topics ORDER BY id ASC) t;")
      if [ -z "$SOCKET_JSON" ] || [ "$SOCKET_JSON" = "[]" ]; then
        SOCKET_JSON=$(run_q "SELECT COALESCE(json_agg(t), '[]'::json) FROM (SELECT * FROM public.socket_topic ORDER BY id ASC) t;")
      fi

      echo "===RESULT==="
      echo "\${POD_JSON:-[]}"
      echo "===SPLIT==="
      echo "\${SOCKET_JSON:-[]}"
    `;

    const sshRes = await executeSshCommand(podServer, fetchCmd, { timeout: 8000 });
    const stdout = sshRes.stdout || '';

    if (stdout.includes('===RESULT===')) {
      const parts = stdout.split('===RESULT===')[1].split('===SPLIT===');
      let podTopics = [];
      let socketTopics = [];

      try {
        podTopics = JSON.parse(parts[0].trim());
      } catch (_) { }

      try {
        socketTopics = JSON.parse(parts[1].trim());
      } catch (_) { }

      return {
        serverId: podServer.id,
        serverName: podServer.name,
        host: podServer.host,
        podTopics: Array.isArray(podTopics) ? podTopics : [],
        socketTopics: Array.isArray(socketTopics) ? socketTopics : [],
        method: 'ssh_fallback',
        success: true
      };
    }

    throw new Error('Gagal mengambil data topic via SSH.');
  } catch (sshErr) {
    return {
      serverId: podServer.id,
      serverName: podServer.name,
      host: podServer.host,
      podTopics: [],
      socketTopics: [],
      method: 'failed',
      success: false,
      error: sshErr.message || 'Koneksi ke database POD gagal.'
    };
  }
}

/**
 * Compare pod_topics and socket_topics across all registered POD V3 servers
 */
async function compareAllPodTopics() {
  // Fetch all POD servers from database
  const allServers = await dbAsync.all('SELECT * FROM servers WHERE type = ?', ['pod']);

  // Filter Pod V3
  const podV3List = allServers.filter(s => {
    const podVer = (s.pod_version || '').toLowerCase().trim();
    const nameStr = (s.name || '').toLowerCase().trim();
    if (podVer === 'v2' || nameStr.includes('v2')) return false;
    return true;
  });

  if (podV3List.length === 0) {
    return {
      pods: [],
      podTopicMatrix: [],
      socketTopicMatrix: [],
      summary: { totalPods: 0, totalPodTopics: 0, totalSocketTopics: 0, missingCount: 0 }
    };
  }

  // Fetch topics in parallel from all PODs
  const fetchPromises = podV3List.map(pod => fetchTopicsFromPod(pod));
  const results = await Promise.all(fetchPromises);

  const successfulPods = results.filter(r => r.success);
  const totalPods = successfulPods.length;
  // Map results for quick lookup
  const resultsByServerId = new Map(results.map(r => [r.serverId, r]));

  // 1. Build POD Topics Matrix
  const podTopicMap = new Map();

  for (const res of results) {
    if (!res.success) continue;
    for (const row of res.podTopics) {
      const topicKey = (row.topic || row.topic_name || row.name || `topic_${row.id}`).trim();
      if (!podTopicMap.has(topicKey)) {
        podTopicMap.set(topicKey, {
          topicKey,
          sampleRow: row,
          presenceByServer: {},
          presentCount: 0
        });
      }
      const entry = podTopicMap.get(topicKey);
      entry.presenceByServer[res.serverId] = {
        present: true,
        isOffline: false,
        data: row
      };
      entry.presentCount += 1;
    }
  }

  const podTopicMatrix = Array.from(podTopicMap.values()).map(entry => {
    const isMissingInSome = totalPods > 0 && entry.presentCount < totalPods;
    const isUniversal = totalPods > 0 && entry.presentCount >= totalPods;

    // Fill presence per pod with offline awareness
    const presence = {};
    for (const pod of podV3List) {
      const podRes = resultsByServerId.get(pod.id);
      const isOnline = podRes ? podRes.success : false;
      if (!isOnline) {
        presence[pod.id] = { present: false, isOffline: true, data: null };
      } else {
        presence[pod.id] = entry.presenceByServer[pod.id] || { present: false, isOffline: false, data: null };
      }
    }

    return {
      topicKey: entry.topicKey,
      sampleRow: entry.sampleRow,
      presence,
      presentCount: entry.presentCount,
      totalPods,
      isMissingInSome,
      isUniversal
    };
  }).sort((a, b) => {
    if (a.isMissingInSome && !b.isMissingInSome) return -1;
    if (!a.isMissingInSome && b.isMissingInSome) return 1;
    return a.topicKey.localeCompare(b.topicKey);
  });

  // 2. Build Socket Topics Matrix
  const socketTopicMap = new Map();

  for (const res of results) {
    if (!res.success) continue;
    for (const row of res.socketTopics) {
      const socketKey = (row.topic || row.topic_name || row.name || row.event || `socket_${row.id}`).trim();
      if (!socketTopicMap.has(socketKey)) {
        socketTopicMap.set(socketKey, {
          socketKey,
          sampleRow: row,
          presenceByServer: {},
          presentCount: 0
        });
      }
      const entry = socketTopicMap.get(socketKey);
      entry.presenceByServer[res.serverId] = {
        present: true,
        isOffline: false,
        data: row
      };
      entry.presentCount += 1;
    }
  }

  const socketTopicMatrix = Array.from(socketTopicMap.values()).map(entry => {
    const isMissingInSome = totalPods > 0 && entry.presentCount < totalPods;
    const isUniversal = totalPods > 0 && entry.presentCount >= totalPods;

    const presence = {};
    for (const pod of podV3List) {
      const podRes = resultsByServerId.get(pod.id);
      const isOnline = podRes ? podRes.success : false;
      if (!isOnline) {
        presence[pod.id] = { present: false, isOffline: true, data: null };
      } else {
        presence[pod.id] = entry.presenceByServer[pod.id] || { present: false, isOffline: false, data: null };
      }
    }

    return {
      socketKey: entry.socketKey,
      sampleRow: entry.sampleRow,
      presence,
      presentCount: entry.presentCount,
      totalPods,
      isMissingInSome,
      isUniversal
    };
  }).sort((a, b) => {
    if (a.isMissingInSome && !b.isMissingInSome) return -1;
    if (!a.isMissingInSome && b.isMissingInSome) return 1;
    return a.socketKey.localeCompare(b.socketKey);
  });

  const missingPodTopicCount = podTopicMatrix.filter(m => m.isMissingInSome).length;
  const missingSocketTopicCount = socketTopicMatrix.filter(m => m.isMissingInSome).length;

  return {
    pods: results.map(r => ({
      id: r.serverId,
      name: r.serverName,
      success: r.success,
      isOnline: r.success,
      method: r.method,
      error: r.error,
      podTopicCount: r.podTopics ? r.podTopics.length : 0,
      socketTopicCount: r.socketTopics ? r.socketTopics.length : 0
    })),
    podTopicMatrix,
    socketTopicMatrix,
    summary: {
      totalPods: podV3List.length,
      successfulPods: totalPods,
      offlinePods: podV3List.length - totalPods,
      totalPodTopics: podTopicMatrix.length,
      totalSocketTopics: socketTopicMatrix.length,
      missingPodTopicCount,
      missingSocketTopicCount,
      hasIssues: missingPodTopicCount > 0 || missingSocketTopicCount > 0
    }
  };
}

/**
 * Synchronize missing topics from a source POD to one or more target PODs
 * @param {Object} params - { sourceServerId, targetServerIds, topicKeys, type: 'pod_topics' | 'socket_topics' }
 */
async function syncMissingTopics({ sourceServerId, targetServerIds, topicKeys = [], type = 'pod_topics' }) {
  if (!sourceServerId || !targetServerIds || targetServerIds.length === 0) {
    throw new Error('sourceServerId dan targetServerIds harus disertakan.');
  }

  const isSocket = type.includes('socket');

  // 1. Fetch source POD data
  const sourceServer = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sourceServerId]);
  if (!sourceServer) throw new Error('Source server tidak ditemukan.');

  const sourceData = await fetchTopicsFromPod(sourceServer);
  if (!sourceData.success) throw new Error(`Gagal membaca data dari source ${sourceServer.name}: ${sourceData.error}`);

  const rowsList = isSocket ? sourceData.socketTopics : sourceData.podTopics;

  // Filter only requested topics (or all if topicKeys is empty)
  const rowsToSync = topicKeys.length > 0
    ? rowsList.filter(r => {
      const key = (r.topic || r.topic_name || r.name || r.event || '').trim();
      return topicKeys.includes(key);
    })
    : rowsList;

  if (rowsToSync.length === 0) {
    throw new Error('Tidak ada baris topic yang ditemukan untuk disinkronkan.');
  }

  // 2. Sync to each target POD
  const syncResults = [];

  for (const targetId of targetServerIds) {
    const targetServer = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [targetId]);
    if (!targetServer) {
      syncResults.push({ serverId: targetId, success: false, error: 'Target server tidak ditemukan.' });
      continue;
    }

    try {
      // Direct Postgres insertion with plural/singular resolution
      const client = new Client({
        connectionString: getPodDbUrl(targetServer.host),
        connectionTimeoutMillis: 3000
      });

      await client.connect();

      // Detect table name on target
      let targetTable = isSocket ? 'public.socket_topics' : 'public.pod_topics';
      try {
        await client.query(`SELECT 1 FROM ${targetTable} LIMIT 1`);
      } catch (_) {
        targetTable = isSocket ? 'public.socket_topic' : 'public.pod_topic';
      }

      let insertedCount = 0;
      for (const row of rowsToSync) {
        const fields = Object.keys(row).filter(f => f !== 'id' && f !== 'created_at' && f !== 'updated_at');
        const values = fields.map(f => row[f]);
        const placeholders = fields.map((_, idx) => `$${idx + 1}`).join(', ');

        const insertSql = `
          INSERT INTO ${targetTable} (${fields.join(', ')})
          VALUES (${placeholders})
          ON CONFLICT DO NOTHING
        `;

        try {
          const res = await client.query(insertSql, values);
          if (res.rowCount > 0) insertedCount += 1;
        } catch (insertErr) {
          console.warn(`Direct insert failed on ${targetServer.name} for topic:`, insertErr.message);
        }
      }

      await client.end();

      syncResults.push({
        serverId: targetId,
        serverName: targetServer.name,
        success: true,
        insertedCount,
        totalAttempted: rowsToSync.length
      });
    } catch (directErr) {
      // Fallback SSH insertion
      try {
        let insertedCount = 0;
        const targetTable = isSocket ? 'public.socket_topics' : 'public.pod_topics';

        for (const row of rowsToSync) {
          const fields = Object.keys(row).filter(f => f !== 'id' && f !== 'created_at' && f !== 'updated_at');
          const valuesStr = fields.map(f => {
            const val = row[f];
            if (val === null || val === undefined) return 'NULL';
            if (typeof val === 'number' || typeof val === 'boolean') return val;
            return `'${String(val).replace(/'/g, "''")}'`;
          }).join(', ');

          const insertSql = `INSERT INTO ${targetTable} (${fields.join(', ')}) VALUES (${valuesStr}) ON CONFLICT DO NOTHING;`;
          const sshCmd = `export PGPASSWORD='${DB_PASS}' && psql -U ${DB_USER} -h 127.0.0.1 -d ${DB_NAME} -c "${insertSql}"`;

          await executeSshCommand(targetServer, sshCmd, { timeout: 5000 });
          insertedCount += 1;
        }

        syncResults.push({
          serverId: targetId,
          serverName: targetServer.name,
          success: true,
          method: 'ssh_fallback',
          insertedCount,
          totalAttempted: rowsToSync.length
        });
      } catch (sshErr) {
        syncResults.push({
          serverId: targetId,
          serverName: targetServer.name,
          success: false,
          error: `Gagal sinkronisasi: ${sshErr.message}`
        });
      }
    }
  }

  return {
    success: true,
    rowsCount: rowsToSync.length,
    syncResults
  };
}

/**
 * Register a new topic (e.g. captured live from MQTT) into one or all POD databases
 */
async function registerTopicToPods({ topic, type = 'pod_topics', description = 'Auto-registered from MQTT debugger', targetServerIds = [] }) {
  if (!topic) throw new Error('Topic harus diisi.');

  const allPods = await dbAsync.all('SELECT * FROM servers WHERE type = ?', ['pod']);
  const targetPods = targetServerIds.length > 0
    ? allPods.filter(p => targetServerIds.includes(p.id))
    : allPods;

  if (targetPods.length === 0) throw new Error('Tidak ada POD target yang valid.');

  const isSocket = type.includes('socket');
  const results = [];

  for (const pod of targetPods) {
    try {
      const client = new Client({
        connectionString: getPodDbUrl(pod.host),
        connectionTimeoutMillis: 3000
      });
      await client.connect();

      let targetTable = isSocket ? 'public.socket_topics' : 'public.pod_topics';
      try {
        await client.query(`SELECT 1 FROM ${targetTable} LIMIT 1`);
      } catch (_) {
        targetTable = isSocket ? 'public.socket_topic' : 'public.pod_topic';
      }

      const insertSql = isSocket
        ? `INSERT INTO ${targetTable} (event, description) VALUES ($1, $2) ON CONFLICT DO NOTHING;`
        : `INSERT INTO ${targetTable} (topic, type, description) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING;`;

      const values = isSocket ? [topic, description] : [topic, 'command', description];
      await client.query(insertSql, values);
      await client.end();

      results.push({ serverId: pod.id, serverName: pod.name, success: true });
    } catch (err) {
      results.push({ serverId: pod.id, serverName: pod.name, success: false, error: err.message });
    }
  }

  return { success: true, results };
}

module.exports = {
  fetchTopicsFromPod,
  compareAllPodTopics,
  syncMissingTopics,
  registerTopicToPods,
  getPodDbUrl
};

