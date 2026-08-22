const { dbAsync } = require('../db');
const { ALL_POD_APPS } = require('./versionScanner');

/**
 * Service to manage Bundle Definitions and calculate per-POD Bundle Compliance
 */

/**
 * Get all bundle definitions with optional environment filter
 */
async function getAllBundleDefinitions(environment = null) {
  let query = 'SELECT * FROM bundle_definitions WHERE 1=1';
  const params = [];
  if (environment) {
    query += ' AND environment = ?';
    params.push(environment);
  }
  query += ' ORDER BY created_at DESC';
  return await dbAsync.all(query, params);
}

/**
 * Get a single bundle definition by ID
 */
async function getBundleDefinitionById(id) {
  return await dbAsync.get('SELECT * FROM bundle_definitions WHERE id = ?', [id]);
}

/**
 * Create a new bundle definition
 */
async function createBundleDefinition({
  bundle_name,
  bundle_version,
  environment = 'dev',
  description = null,
  mobile_api_version,
  mobile_synch_version,
  mobile_consume_version,
  mobile_downloader_version,
  assist_api_version,
  mobile_api_env = '',
  mobile_api_prisma = false,
  mobile_synch_env = '',
  mobile_synch_prisma = false,
  mobile_consume_env = '',
  mobile_consume_prisma = false,
  mobile_downloader_env = '',
  mobile_downloader_prisma = false,
  assist_api_env = '',
  assist_api_prisma = false,
  small_screen_version,
  big_screen_version,
  created_by = 'Admin'
}) {
  if (!bundle_name || !bundle_version) {
    throw new Error('Nama bundle dan versi bundle wajib diisi');
  }

  const res = await dbAsync.run(`
    INSERT INTO bundle_definitions (
      bundle_name, bundle_version, environment, description,
      mobile_api_version, mobile_synch_version, mobile_consume_version,
      mobile_downloader_version, assist_api_version,
      mobile_api_env, mobile_api_prisma,
      mobile_synch_env, mobile_synch_prisma,
      mobile_consume_env, mobile_consume_prisma,
      mobile_downloader_env, mobile_downloader_prisma,
      assist_api_env, assist_api_prisma,
      small_screen_version, big_screen_version,
      created_by, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `, [
    bundle_name,
    bundle_version,
    environment,
    description,
    mobile_api_version || 'dev-latest',
    mobile_synch_version || 'dev-latest',
    mobile_consume_version || 'dev-latest',
    mobile_downloader_version || 'dev-latest',
    assist_api_version || 'dev-latest',
    mobile_api_env || '',
    mobile_api_prisma ? true : false,
    mobile_synch_env || '',
    mobile_synch_prisma ? true : false,
    mobile_consume_env || '',
    mobile_consume_prisma ? true : false,
    mobile_downloader_env || '',
    mobile_downloader_prisma ? true : false,
    assist_api_env || '',
    assist_api_prisma ? true : false,
    small_screen_version || '0.0.0',
    big_screen_version || '0.0.0',
    created_by
  ]);

  return await getBundleDefinitionById(res.lastInsertRowid);
}

/**
 * Update an existing bundle definition
 */
async function updateBundleDefinition(id, {
  bundle_name,
  bundle_version,
  environment,
  description,
  mobile_api_version,
  mobile_synch_version,
  mobile_consume_version,
  mobile_downloader_version,
  assist_api_version,
  mobile_api_env,
  mobile_api_prisma,
  mobile_synch_env,
  mobile_synch_prisma,
  mobile_consume_env,
  mobile_consume_prisma,
  mobile_downloader_env,
  mobile_downloader_prisma,
  assist_api_env,
  assist_api_prisma,
  small_screen_version,
  big_screen_version
}) {
  await dbAsync.run(`
    UPDATE bundle_definitions SET
      bundle_name = COALESCE(?, bundle_name),
      bundle_version = COALESCE(?, bundle_version),
      environment = COALESCE(?, environment),
      description = COALESCE(?, description),
      mobile_api_version = COALESCE(?, mobile_api_version),
      mobile_synch_version = COALESCE(?, mobile_synch_version),
      mobile_consume_version = COALESCE(?, mobile_consume_version),
      mobile_downloader_version = COALESCE(?, mobile_downloader_version),
      assist_api_version = COALESCE(?, assist_api_version),
      mobile_api_env = COALESCE(?, mobile_api_env),
      mobile_api_prisma = COALESCE(?, mobile_api_prisma),
      mobile_synch_env = COALESCE(?, mobile_synch_env),
      mobile_synch_prisma = COALESCE(?, mobile_synch_prisma),
      mobile_consume_env = COALESCE(?, mobile_consume_env),
      mobile_consume_prisma = COALESCE(?, mobile_consume_prisma),
      mobile_downloader_env = COALESCE(?, mobile_downloader_env),
      mobile_downloader_prisma = COALESCE(?, mobile_downloader_prisma),
      assist_api_env = COALESCE(?, assist_api_env),
      assist_api_prisma = COALESCE(?, assist_api_prisma),
      small_screen_version = COALESCE(?, small_screen_version),
      big_screen_version = COALESCE(?, big_screen_version),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `, [
    bundle_name,
    bundle_version,
    environment,
    description,
    mobile_api_version,
    mobile_synch_version,
    mobile_consume_version,
    mobile_downloader_version,
    assist_api_version,
    mobile_api_env,
    mobile_api_prisma !== undefined ? Boolean(mobile_api_prisma) : null,
    mobile_synch_env,
    mobile_synch_prisma !== undefined ? Boolean(mobile_synch_prisma) : null,
    mobile_consume_env,
    mobile_consume_prisma !== undefined ? Boolean(mobile_consume_prisma) : null,
    mobile_downloader_env,
    mobile_downloader_prisma !== undefined ? Boolean(mobile_downloader_prisma) : null,
    assist_api_env,
    assist_api_prisma !== undefined ? Boolean(assist_api_prisma) : null,
    small_screen_version,
    big_screen_version,
    id
  ]);

  return await getBundleDefinitionById(id);
}

/**
 * Delete a bundle definition
 */
async function deleteBundleDefinition(id) {
  return await dbAsync.run('DELETE FROM bundle_definitions WHERE id = ?', [id]);
}

/**
 * Calculate bundle compliance for all POD v3 nodes against defined bundles and active app versions
 */
async function getPodBundleMatrix() {
  const pods = await dbAsync.all("SELECT id, name, host, port, code, pod_version FROM servers WHERE type = 'pod' AND pod_version = 'v3' ORDER BY CAST(NULLIF(regexp_replace(code, '\\D', '', 'g'), '') AS INTEGER) ASC NULLS LAST, name ASC");
  const bundles = await dbAsync.all('SELECT * FROM bundle_definitions ORDER BY created_at DESC');
  const appVersions = await dbAsync.all('SELECT * FROM pod_app_versions');
  const bundleStates = await dbAsync.all('SELECT * FROM pod_bundle_states');

  const matrix = pods.map(pod => {
    const podCode = String(pod.code || '');
    const installed = appVersions.filter(v => String(v.pod_code) === podCode);
    const existingState = bundleStates.find(s => String(s.pod_code) === podCode);

    // Map installed versions for the 7 apps
    const installedMap = {
      'mobile-api': installed.find(a => a.app_name === 'mobile-api')?.current_version || null,
      'mobile-synch': installed.find(a => a.app_name === 'mobile-synch')?.current_version || null,
      'mobile-consume': installed.find(a => a.app_name === 'mobile-consume')?.current_version || null,
      'mobile-downloader': installed.find(a => a.app_name === 'mobile-downloader')?.current_version || null,
      'assist-api': installed.find(a => a.app_name === 'assist-api')?.current_version || null,
      'small-screen': installed.find(a => a.app_name === 'small-screen')?.current_version || null,
      'big-screen': installed.find(a => a.app_name === 'big-screen')?.current_version || null
    };

    // Find assigned or best-matching bundle definition
    let targetBundle = null;
    if (existingState?.bundle_id) {
      targetBundle = bundles.find(b => b.id === existingState.bundle_id) || null;
    }

    // If no assigned bundle, try to find an exact matching bundle
    if (!targetBundle && bundles.length > 0) {
      targetBundle = bundles.find(b => (
        b.mobile_api_version === installedMap['mobile-api'] &&
        b.mobile_synch_version === installedMap['mobile-synch'] &&
        b.mobile_consume_version === installedMap['mobile-consume'] &&
        b.mobile_downloader_version === installedMap['mobile-downloader'] &&
        b.assist_api_version === installedMap['assist-api'] &&
        b.small_screen_version === installedMap['small-screen'] &&
        b.big_screen_version === installedMap['big-screen']
      )) || null;
    }

    // Calculate match percentage against target bundle if available
    let compliancePct = 0;
    let complianceStatus = 'unassigned';
    let matchedAppsCount = 0;
    const diffs = [];

    if (targetBundle) {
      const bundleMap = {
        'mobile-api': targetBundle.mobile_api_version,
        'mobile-synch': targetBundle.mobile_synch_version,
        'mobile-consume': targetBundle.mobile_consume_version,
        'mobile-downloader': targetBundle.mobile_downloader_version,
        'assist-api': targetBundle.assist_api_version,
        'small-screen': targetBundle.small_screen_version,
        'big-screen': targetBundle.big_screen_version
      };

      Object.keys(bundleMap).forEach(appName => {
        if (installedMap[appName] && installedMap[appName] === bundleMap[appName]) {
          matchedAppsCount++;
        } else {
          diffs.push({
            app_name: appName,
            expected: bundleMap[appName],
            installed: installedMap[appName] || 'Belum Terpasang'
          });
        }
      });

      compliancePct = Math.round((matchedAppsCount / 7) * 100);
      complianceStatus = compliancePct === 100 ? 'synced' : 'mismatched';
    } else {
      // Check how many apps are installed
      const installedCount = Object.values(installedMap).filter(Boolean).length;
      compliancePct = Math.round((installedCount / 7) * 100);
      complianceStatus = installedCount === 7 ? 'custom' : 'partial';
    }

    return {
      server_id: pod.id,
      pod_code: pod.code,
      server_name: pod.name,
      host: pod.host,
      pod_version: pod.pod_version || 'v3',
      bundle_id: targetBundle?.id || existingState?.bundle_id || null,
      bundle_name: targetBundle?.bundle_name || existingState?.custom_bundle_tag || (complianceStatus === 'custom' ? 'Custom Bundle' : 'Belum Ada Bundle'),
      bundle_version: targetBundle?.bundle_version || null,
      environment: targetBundle?.environment || 'dev',
      compliance_status: complianceStatus,
      compliance_pct: compliancePct,
      matched_apps_count: matchedAppsCount,
      total_apps: 7,
      diffs,
      installed_apps: installedMap,
      last_deployed_by: existingState?.last_deployed_by || null,
      last_deployed_at: existingState?.last_deployed_at || null
    };
  });

  return matrix;
}

/**
 * Assign / update bundle state for a specific POD
 */
async function assignPodBundleState({ pod_code, bundle_id, deployed_by = 'Admin' }) {
  if (!pod_code) throw new Error('pod_code wajib diisi');
  
  await dbAsync.run(`
    INSERT INTO pod_bundle_states (
      pod_code, bundle_id, compliance_status, compliance_pct, last_deployed_by, last_deployed_at, updated_at
    ) VALUES (?, ?, 'synced', 100, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT (pod_code) DO UPDATE SET
      bundle_id = EXCLUDED.bundle_id,
      last_deployed_by = EXCLUDED.last_deployed_by,
      last_deployed_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `, [pod_code, bundle_id || null, deployed_by]);

  return { success: true };
}

module.exports = {
  getAllBundleDefinitions,
  getBundleDefinitionById,
  createBundleDefinition,
  updateBundleDefinition,
  deleteBundleDefinition,
  getPodBundleMatrix,
  assignPodBundleState
};
