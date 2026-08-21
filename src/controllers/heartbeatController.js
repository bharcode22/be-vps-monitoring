const db = require('../services/db');

/**
 * Fetch and parse raw Heartbeat payload from microservice
 */
async function fetchRawHeartbeat() {
  const heartbeatUrl = process.env.HEARTBEAT_URL || 'http://10.20.10.3:2880/heartbeat';
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const response = await fetch(heartbeatUrl, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json'
      }
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Heartbeat endpoint returned HTTP status ${response.status}`);
    }

    const json = await response.json();
    const items = [];

    // Parse each key (e.g., "hb33", "hb14", "hb31", etc.)
    for (const [key, raw] of Object.entries(json || {})) {
      if (!raw || typeof raw !== 'object') continue;

      let latitude = null;
      let longitude = null;

      // Extract latitude & longitude from location string / object
      if (raw.location) {
        if (typeof raw.location === 'string') {
          try {
            const parsedLoc = JSON.parse(raw.location);
            if (parsedLoc && (parsedLoc.lat !== undefined || parsedLoc.latitude !== undefined)) {
              latitude = String(parsedLoc.lat !== undefined ? parsedLoc.lat : parsedLoc.latitude);
              longitude = String(parsedLoc.long !== undefined ? parsedLoc.long : (parsedLoc.lng || parsedLoc.longitude));
            }
          } catch (e) {
            // Location string might be comma-separated "lat,long"
            const parts = raw.location.split(',');
            if (parts.length === 2 && !isNaN(parts[0]) && !isNaN(parts[1])) {
              latitude = parts[0].trim();
              longitude = parts[1].trim();
            }
          }
        } else if (typeof raw.location === 'object') {
          latitude = String(raw.location.lat !== undefined ? raw.location.lat : raw.location.latitude || '');
          longitude = String(raw.location.long !== undefined ? raw.location.long : (raw.location.lng || raw.location.longitude || ''));
        }
      }

      items.push({
        key,
        pod_id: raw.pod_id !== undefined && raw.pod_id !== null ? String(raw.pod_id) : null,
        ip: raw.ip || null,
        mac_address: raw.mac_address || null,
        latitude: latitude || null,
        longitude: longitude || null,
        hasLocation: Boolean(latitude && longitude),
        ping_status: Boolean(raw.ping_status),
        hours: raw.hours !== undefined ? Number(raw.hours) : 0,
        influx_bucket: raw.influx_bucket || 'pod_monitoring',
        heartbeat_metrics: raw.heartbeat_metrics || {}
      });
    }

    return items;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('❌ Failed to fetch Heartbeat payload:', err.message);
    throw err;
  }
}

/**
 * GET /api/heartbeat/live
 * Return real-time heartbeat data combined with database servers info
 */
const getHeartbeatData = async (req, res) => {
  try {
    const heartbeatItems = await fetchRawHeartbeat();
    const servers = await db.all('SELECT id, name, host, code, latitude, longitude, mac_address, type, pod_version FROM servers');

    // Cross-match heartbeat items with registered servers in DB
    const enrichedList = heartbeatItems.map(hb => {
      const matchedServer = servers.find(s => {
        if (s.code && String(s.code).trim() === String(hb.pod_id).trim()) return true;
        if (s.host && hb.ip && s.host === hb.ip) return true;
        if (hb.pod_id && s.name && new RegExp(`\\b${hb.pod_id}\\b`, 'i').test(s.name)) return true;
        return false;
      });

      return {
        ...hb,
        server_id: matchedServer ? matchedServer.id : null,
        server_name: matchedServer ? matchedServer.name : `POD ${hb.pod_id || hb.key}`,
        is_registered: Boolean(matchedServer),
        pod_version: matchedServer ? matchedServer.pod_version : (hb.pod_id >= 30 ? 'v3' : 'v2')
      };
    });

    const summary = {
      totalHeartbeats: heartbeatItems.length,
      totalRegisteredServers: servers.length,
      matchedCount: enrichedList.filter(e => e.is_registered).length,
      locatedCount: enrichedList.filter(e => e.hasLocation).length,
      onlineCount: enrichedList.filter(e => e.ping_status).length,
      timestamp: new Date().toISOString()
    };

    res.json({
      success: true,
      data: enrichedList,
      summary
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      error: `Gagal memuat data heartbeat: ${err.message}`
    });
  }
};

/**
 * POST /api/heartbeat/sync
 * Fetch live heartbeat data, match with servers, and persist latitude, longitude, mac_address, and code
 */
const syncHeartbeatToServers = async (req, res) => {
  try {
    const heartbeatItems = await fetchRawHeartbeat();
    const servers = await db.all('SELECT id, name, host, code, latitude, longitude, mac_address, type FROM servers');

    let updatedCount = 0;
    const syncLogs = [];

    for (const hb of heartbeatItems) {
      // Find matching server in database
      let matchedServer = null;

      // 1. Match by exact code
      if (hb.pod_id) {
        matchedServer = servers.find(s => s.code && String(s.code).trim() === String(hb.pod_id).trim());
      }

      // 2. Match by exact Host IP
      if (!matchedServer && hb.ip) {
        matchedServer = servers.find(s => s.host === hb.ip);
      }

      // 3. Match by name keyword pattern (e.g. "POD 33" -> "33", "POD RIG 30" -> "30")
      if (!matchedServer && hb.pod_id) {
        matchedServer = servers.find(s => s.name && new RegExp(`\\b${hb.pod_id}\\b`, 'i').test(s.name));
      }

      if (matchedServer) {
        const newCode = matchedServer.code || hb.pod_id;
        const newLat = hb.latitude || matchedServer.latitude || null;
        const newLong = hb.longitude || matchedServer.longitude || null;
        const newMac = hb.mac_address || matchedServer.mac_address || null;

        await db.run(
          `UPDATE servers 
           SET code = $1, latitude = $2, longitude = $3, mac_address = $4 
           WHERE id = $5`,
          [newCode, newLat, newLong, newMac, matchedServer.id]
        );

        updatedCount++;
        syncLogs.push({
          server_id: matchedServer.id,
          server_name: matchedServer.name,
          code: newCode,
          ip: hb.ip,
          mac_address: newMac,
          latitude: newLat,
          longitude: newLong,
          status: 'updated'
        });
      }
    }

    // Trigger websocket notification to update live UI
    const io = req.app.get('io');
    if (io) {
      io.emit('server_list_updated');
    }

    res.json({
      success: true,
      message: `Sinkronisasi berhasil! ${updatedCount} server berhasil diperbarui dengan data koordinat GPS & MAC address.`,
      updatedCount,
      totalHeartbeats: heartbeatItems.length,
      logs: syncLogs,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('❌ Heartbeat sync error:', err.message);
    res.status(500).json({
      success: false,
      error: `Gagal melakukan sinkronisasi heartbeat: ${err.message}`
    });
  }
};

module.exports = {
  getHeartbeatData,
  syncHeartbeatToServers,
  fetchRawHeartbeat
};
