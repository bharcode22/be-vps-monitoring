const db = require('../db');
const { executeSSHCommand } = require('./sshExecutor');

// List of all 7 target apps
const ALL_KNOWN_APPS = [
  { name: 'mobile-api', label: 'Mobile API', type: 'backend', aliases: ['mobile-api', 'mobile_api'] },
  { name: 'mobile-synch', label: 'Mobile Sync', type: 'backend', aliases: ['mobile-synch', 'mobile-sync', 'mobile_synch', 'mobile_sync'] },
  { name: 'mobile-consume', label: 'Mobile Consume', type: 'backend', aliases: ['mobile-consume', 'mobile-consumer', 'mobile_consume'] },
  { name: 'mobile-downloader', label: 'Mobile Downloader', type: 'backend', aliases: ['mobile-downloader', 'mobile_downloader'] },
  { name: 'assist-api', label: 'Assist API', type: 'backend', aliases: ['assist-api', 'assist_api'] },
  { name: 'small-screen', label: 'Small Screen App', type: 'frontend', aliases: ['small-screen', 'small-screen-app', 'small_screen'] },
  { name: 'big-screen', label: 'Big Screen App', type: 'frontend', aliases: ['big-screen', 'big-screen-app', 'big_screen'] }
];

/**
 * Scan a single POD server for installed/running application versions via SSH
 */
async function scanServerInstalledVersions(server) {
  if (!server || !server.code) {
    return {
      pod_code: server?.code || null,
      server_id: server?.id,
      server_name: server?.name,
      apps: []
    };
  }

  const podCode = String(server.code);
  const detectedApps = [];

  const scanScript = `
echo "=== DOCKER CONTAINERS ==="
docker ps -a --format '{{.Names}}:::{{.Image}}:::{{.Status}}' 2>/dev/null || true

echo "=== DEBIAN PACKAGES ==="
dpkg-query -W -f='\${Package}:::\${Version}\\n' big-screen small-screen big-screen-app small-screen-app 2>/dev/null || true

echo "=== VERSION DIRECTORIES ==="
find /home/pod/dev /home/pod/release /home/pod/workspace/Deployment -maxdepth 3 -type d 2>/dev/null | head -n 40 || true
`.trim();

  try {
    const res = await executeSSHCommand(server, scanScript);
    const output = res.stdout || '';

    const lines = output.split('\n');
    let section = '';
    const dockerMap = {};
    const debMap = {};
    const dirList = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (line.includes('=== DOCKER CONTAINERS ===')) {
        section = 'docker';
        continue;
      }
      if (line.includes('=== DEBIAN PACKAGES ===')) {
        section = 'deb';
        continue;
      }
      if (line.includes('=== VERSION DIRECTORIES ===')) {
        section = 'dirs';
        continue;
      }

      if (!line) continue;

      if (section === 'docker' && line.includes(':::')) {
        const [cName, cImage, cStatus] = line.split(':::');
        dockerMap[cName.toLowerCase()] = { image: cImage, status: cStatus };
      } else if (section === 'deb' && line.includes(':::')) {
        const [pName, pVersion] = line.split(':::');
        debMap[pName.toLowerCase()] = pVersion;
      } else if (section === 'dirs') {
        dirList.push(line);
      }
    }

    for (const app of ALL_KNOWN_APPS) {
      let currentVersion = 'Not Installed';
      let environment = 'dev';
      let status = 'inactive';

      if (app.type === 'frontend') {
        // Debian package detection
        for (const alias of app.aliases) {
          if (debMap[alias]) {
            currentVersion = debMap[alias];
            status = 'active';
            environment = currentVersion.includes('prod') || currentVersion.includes('rel') ? 'release' : 'dev';
            break;
          }
        }
      } else {
        // Docker container detection
        for (const alias of app.aliases) {
          const matchedDocker = Object.entries(dockerMap).find(([name]) => name.includes(alias));
          if (matchedDocker) {
            const [cName, cInfo] = matchedDocker;
            const imgParts = (cInfo.image || '').split(':');
            const versionTag = imgParts.length > 1 ? imgParts[1] : 'latest';
            currentVersion = versionTag;
            status = (cInfo.status || '').toLowerCase().includes('up') ? 'active' : 'inactive';
            environment = (cInfo.image || '').includes('prod') || (cInfo.image || '').includes('release') ? 'release' : 'dev';
            break;
          }
        }

        // If not running in docker, check if directories exist
        if (currentVersion === 'Not Installed') {
          for (const alias of app.aliases) {
            const matchedDir = dirList.find(d => d.toLowerCase().includes(alias));
            if (matchedDir) {
              const pathParts = matchedDir.split('/');
              const lastFolder = pathParts[pathParts.length - 1];
              if (lastFolder.startsWith('dev-') || lastFolder.startsWith('v') || lastFolder.startsWith('release-')) {
                currentVersion = lastFolder;
                environment = matchedDir.includes('/release') ? 'release' : 'dev';
                status = 'inactive';
                break;
              }
            }
          }
        }
      }

      // If version is not 'Not Installed', upsert into pod_app_versions
      if (currentVersion !== 'Not Installed') {
        const now = new Date().toISOString();
        await db.run(`
          INSERT INTO pod_app_versions (pod_code, app_name, app_type, environment, current_version, status, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (pod_code, app_name) DO UPDATE SET
            app_type = EXCLUDED.app_type,
            environment = EXCLUDED.environment,
            current_version = EXCLUDED.current_version,
            status = EXCLUDED.status,
            updated_at = EXCLUDED.updated_at
        `, [podCode, app.name, app.type, environment, currentVersion, status, now]);
      }

      detectedApps.push({
        app_name: app.name,
        label: app.label,
        app_type: app.type,
        environment,
        current_version: currentVersion,
        status
      });
    }

    return {
      pod_code: podCode,
      server_id: server.id,
      server_name: server.name,
      host: server.host,
      apps: detectedApps
    };
  } catch (err) {
    console.error(`Error scanning versions for server ${server.name} (${server.code}):`, err.message);
    return {
      pod_code: podCode,
      server_id: server.id,
      server_name: server.name,
      host: server.host,
      error: err.message,
      apps: []
    };
  }
}

/**
 * Scan multiple servers or all registered POD v3 servers in parallel
 */
async function scanAllPodAppVersions(serverIds = null) {
  let query = "SELECT id, name, host, port, username, auth_type, password, private_key, code, pod_version FROM servers WHERE type = 'pod' AND pod_version = 'v3'";
  let params = [];
  if (Array.isArray(serverIds) && serverIds.length > 0) {
    query += ` AND id = ANY($1)`;
    params = [serverIds];
  }

  const servers = await db.all(query, params);
  const results = await Promise.all(servers.map(s => scanServerInstalledVersions(s)));
  return results;
}

/**
 * Get all current app versions grouped by POD code from the database (strictly POD v3)
 */
async function getPodAppVersionsMatrix() {
  const servers = await db.all("SELECT id, name, host, port, code, pod_version FROM servers WHERE type = 'pod' AND pod_version = 'v3' ORDER BY CAST(NULLIF(regexp_replace(code, '\\D', '', 'g'), '') AS INTEGER) ASC NULLS LAST, name ASC");
  const versions = await db.all("SELECT * FROM pod_app_versions ORDER BY pod_code ASC, app_name ASC");

  const matrix = servers.map(server => {
    const podCode = String(server.code || '');
    const serverVersions = versions.filter(v => String(v.pod_code) === podCode);
    return {
      server_id: server.id,
      pod_code: server.code,
      server_name: server.name,
      host: server.host,
      pod_version: server.pod_version || 'v3',
      apps: serverVersions
    };
  });

  return matrix;
}

module.exports = {
  ALL_KNOWN_APPS,
  scanServerInstalledVersions,
  scanAllPodAppVersions,
  getPodAppVersionsMatrix
};
