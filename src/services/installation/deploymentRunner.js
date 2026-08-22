const { dbAsync } = require('../db');
const { executeSSHCommand, executeSSHCommandStream } = require('./sshExecutor');
const { readEnvFileContent } = require('./envService');
const { resolveMinioAppPath } = require('./minioService');
const {
  generateBatchDownloadScript,
  generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet
} = require('./scriptGenerators');

/**
 * Record a deployment entry in deployment_history table
 */
async function recordDeploymentHistory({
  batch_id = null,
  pod_code,
  server_name,
  app_name,
  app_type = 'backend',
  environment = 'dev',
  version,
  env_filename = null,
  run_prisma_migrate = false,
  status = 'success',
  duration_seconds = 0,
  logs = '',
  error_message = null,
  deployed_by = 'Admin'
}) {
  try {
    const res = await dbAsync.run(`
      INSERT INTO deployment_history (
        batch_id, pod_code, server_name, app_name, app_type,
        environment, version, env_filename, run_prisma_migrate,
        status, duration_seconds, logs, error_message, deployed_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      batch_id, pod_code, server_name, app_name, app_type,
      environment, version, env_filename, run_prisma_migrate ? 1 : 0,
      status, Math.round(duration_seconds), logs, error_message, deployed_by
    ]);
    return res.lastInsertRowid;
  } catch (err) {
    console.error('Error saving deployment_history:', err.message);
    return null;
  }
}

/**
 * Upsert active app version in pod_app_versions table
 */
async function upsertPodAppVersion({
  pod_code,
  app_name,
  app_type = 'backend',
  environment = 'dev',
  current_version,
  last_deployment_id = null,
  status = 'active'
}) {
  if (!pod_code || !app_name || !current_version) return;
  try {
    const now = new Date().toISOString();
    await dbAsync.run(`
      INSERT INTO pod_app_versions (
        pod_code, app_name, app_type, environment,
        current_version, last_deployment_id, status, installed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (pod_code, app_name) DO UPDATE SET
        app_type = EXCLUDED.app_type,
        environment = EXCLUDED.environment,
        current_version = EXCLUDED.current_version,
        last_deployment_id = EXCLUDED.last_deployment_id,
        status = EXCLUDED.status,
        updated_at = EXCLUDED.updated_at
    `, [
      pod_code, app_name, app_type, environment,
      current_version, last_deployment_id, status, now, now
    ]);
  } catch (err) {
    console.error('Error updating pod_app_versions:', err.message);
  }
}

/**
 * Execute automated deployment on a single target POD v3 server via SSH
 */
async function deployPodApp({ server_id, app_name, env, version, env_filename, run_prisma_migrate, deployed_by = 'Admin' }) {
  const startTime = Date.now();
  if (!server_id) {
    throw new Error('Server ID (POD v3) wajib ditentukan');
  }
  if (!app_name) {
    throw new Error('Nama aplikasi wajib ditentukan (contoh: mobile-api)');
  }
  if (!version) {
    throw new Error('Versi instalasi wajib ditentukan');
  }

  const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [server_id]);
  if (!server) {
    throw new Error(`Server dengan ID ${server_id} tidak ditemukan`);
  }

  const environment = env || 'dev';
  const isDebApp = app_name === 'big-screen' || app_name === 'small-screen';
  const appType = isDebApp ? 'frontend' : 'backend';

  const logs = [];
  logs.push(`[1/6] Memulai deployment untuk aplikasi: ${app_name} (${environment}) versi: ${version}`);
  logs.push(`[2/6] Menghubungkan ke server ${server.name} (${server.host}:${server.port || 22})...`);

  // Read .env file content if specified
  const envFileContent = readEnvFileContent(env_filename);
  if (envFileContent) {
    logs.push(`[3/6] Menggunakan file env: ${env_filename}`);
  }

  // Path in MinIO bucket & Deployment directory
  const minioAppPath = resolveMinioAppPath(app_name);
  const appDeployDir = isDebApp
    ? `/home/pod/workspace/Deployment/${app_name}-app`
    : `$HOME/${environment}`;

  let envScriptSnippet = '';
  if (envFileContent) {
    envScriptSnippet = `
echo "=== INJECTING SELECTED .ENV FILE (${env_filename}) ==="
cat << 'EOF_ENV_CONFIG' > .env
${envFileContent}
EOF_ENV_CONFIG
echo "File .env berhasil ditulis!"
`;
  }

  let prismaScriptSnippet = '';
  if (run_prisma_migrate) {
    prismaScriptSnippet = `
echo "=== PRISMA MIGRATE STEP: Running npx prisma migrate dev --name \"deploy\" ==="
if [ -d "prisma" ] || [ -f "schema.prisma" ]; then
  npx prisma migrate dev --name "deploy" || npx prisma migrate deploy || echo "Peringatan: npx prisma migrate gagal dijalankan"
elif docker ps -a --format '{{.Names}}' | grep -q "${app_name}"; then
  docker exec ${app_name} npx prisma migrate deploy 2>/dev/null || echo "Peringatan: prisma migrate exec gagal di kontainer"
fi
`;
  }

  let deployScript = '';
  if (isDebApp) {
    deployScript = `
set -e
echo "=== STEP 1: Mempersiapkan direktori ${appDeployDir} ==="
mkdir -p "${appDeployDir}"
cd "${appDeployDir}"

echo "=== STEP 2: Mengunduh bundle artefak dari MinIO (deploybox/${minioAppPath}/${environment}/${version}) ==="
rm -rf dev-* 2>/dev/null || true
rm -rf "${version}" 2>/dev/null || true
mkdir -p "${version}"
cd "${version}"
mc cp --disable-multipart minio-deploy/deploybox/${minioAppPath}/${environment}/${version}/artifact-bundle-${version}.zip ./ || mc cp --recursive minio-deploy/deploybox/${minioAppPath}/${environment}/${version} ./ || echo "Peringatan: mc cp menggunakan fallback lokal atau file sudah ada"

echo "=== STEP 3: Mengekstrak paket artefak (.zip) ==="
ZIP_FILE=$(ls artifact-bundle-*.zip 2>/dev/null | head -n 1)
if [ -z "$ZIP_FILE" ]; then
  ZIP_FILE=$(find . -maxdepth 2 -name "artifact-bundle-*.zip" -o -name "*.zip" 2>/dev/null | head -n 1)
fi
if [ -n "$ZIP_FILE" ]; then
  echo "Unzipping $ZIP_FILE..."
  unzip -o "$ZIP_FILE"
fi

DEB_FILE=$(ls *.deb 2>/dev/null | head -n 1)
if [ -z "$DEB_FILE" ]; then
  DEB_FILE=$(find . -maxdepth 2 -name "*.deb" 2>/dev/null | head -n 1)
fi
PKG_NAME="${app_name}"

if [ -n "$DEB_FILE" ]; then
  DETECTED_PKG=$(dpkg -I "$DEB_FILE" 2>/dev/null | grep "Package:" | cut -d: -f2 | tr -d '[:space:]')
  if [ -n "$DETECTED_PKG" ]; then PKG_NAME="$DETECTED_PKG"; fi
  echo "Paket Debian ditemukan: $DEB_FILE (Nama paket: $PKG_NAME)"
  dpkg -I "$DEB_FILE" || true
fi

echo "=== STEP 4: Menghentikan proses & Menghapus versi lama paket $PKG_NAME ==="
sudo systemctl stop "$PKG_NAME" 2>/dev/null || true
sudo systemctl stop "${app_name}" 2>/dev/null || true

EXACT_PIDS=$(pgrep -x "$PKG_NAME" 2>/dev/null || pgrep -x "${app_name}" 2>/dev/null || pgrep -f "^/usr/bin/$PKG_NAME" 2>/dev/null || true)
if [ -n "$EXACT_PIDS" ]; then
  echo "Menghentikan PID aktif: $EXACT_PIDS..."
  sudo kill -9 $EXACT_PIDS 2>/dev/null || true
fi

TARGET_PKGS=("$PKG_NAME" "${app_name}" "${app_name}-app")
for P in "\${TARGET_PKGS[@]}"; do
  if dpkg -l | grep -q "^ii.*$P"; then
    CURR_VER=$(dpkg-query -W -f='\${Version}' $P 2>/dev/null || echo "unknown")
    echo "📦 Menghapus paket terpasang sebelumnya: $P (versi $CURR_VER)..."
    sudo dpkg -r $P || sudo dpkg --purge $P || true
  fi
done

sudo find /usr -name "*${app_name}*" -type f 2>/dev/null | head -10 || true

echo "=== STEP 5: Meng-install & memverifikasi paket baru $PKG_NAME ==="
if [ -n "$DEB_FILE" ]; then
  sudo dpkg -i "$DEB_FILE" || (sudo apt-get update && sudo apt-get install -f -y)
fi
dpkg -l | grep "^ii.*$PKG_NAME" || exit 1
dpkg-query -W -f='\${Version}' $PKG_NAME
dpkg --verify $PKG_NAME 2>/dev/null || true
echo "=== DEPLOYMENT COMPLETED SUCCESSFULLY ==="
    `.trim();
  } else {
    deployScript = `
set -e
echo "=== STEP 1: Mempersiapkan direktori ${appDeployDir} ==="
mkdir -p "${appDeployDir}"
cd "${appDeployDir}"

echo "=== STEP 2: Menyalin artefak dari MinIO (deploybox/${minioAppPath}/${environment}/${version}) ==="
mc cp --recursive minio-deploy/deploybox/${minioAppPath}/${environment}/${version} ./ || echo "Peringatan: mc cp menggunakan fallback lokal atau file sudah ada"

echo "=== STEP 3: Masuk ke folder versi ${version} ==="
if [ -d "${version}/${version}" ]; then
  cd "${version}/${version}"
elif [ -d "${version}" ]; then
  cd "${version}"
fi

echo "=== STEP 3.5: Mengekstrak paket artefak (.zip) ==="
ZIP_FILE=$(ls artifact-bundle-*.zip 2>/dev/null | head -n 1)
if [ -z "$ZIP_FILE" ]; then
  ZIP_FILE=$(find . -maxdepth 2 -name "artifact-bundle-*.zip" -o -name "*.zip" 2>/dev/null | head -n 1)
fi
if [ -n "$ZIP_FILE" ]; then
  echo "Unzipping $ZIP_FILE..."
  unzip -o "$ZIP_FILE"
fi

${envScriptSnippet}

COMPOSE_FILE=$(ls docker-compose.yaml docker-compose.yml docker-compose.prod.yaml docker-compose.prod.yml compose.yaml compose.yml 2>/dev/null | head -n 1)
if [ -z "$COMPOSE_FILE" ]; then
  COMPOSE_FILE=$(find . -maxdepth 2 -name "docker-compose*.y*ml" -o -name "compose*.y*ml" 2>/dev/null | head -n 1)
fi

echo "=== STEP 4: Menghentikan & menghapus kontainer lama (${app_name}) ==="
if [ -n "$COMPOSE_FILE" ]; then
  docker compose -f "$COMPOSE_FILE" down 2>/dev/null || docker-compose -f "$COMPOSE_FILE" down 2>/dev/null || true
fi
docker stop ${app_name} 2>/dev/null || true
docker rm ${app_name} 2>/dev/null || true

echo "=== STEP 4.5: Membersihkan network & image Docker sisa yang tidak terpakai ==="
docker network prune -f 2>/dev/null || true
docker image prune -f 2>/dev/null || true

echo "=== STEP 5: Memuat Docker Image baru ==="
IMAGE_FILE=$(ls image-*.tar.gz 2>/dev/null | head -n 1)
if [ -z "$IMAGE_FILE" ]; then
  IMAGE_FILE=$(find . -maxdepth 2 -name "image-*.tar.gz" -o -name "*.tar.gz" 2>/dev/null | head -n 1)
fi
if [ -n "$IMAGE_FILE" ]; then
  echo "Loading image dari $IMAGE_FILE..."
  docker load < "$IMAGE_FILE"
fi

${prismaScriptSnippet}

echo "=== STEP 6: Menjalankan kontainer baru dengan docker-compose ==="
if [ -n "$COMPOSE_FILE" ]; then
  docker compose -f "$COMPOSE_FILE" up -d || docker-compose -f "$COMPOSE_FILE" up -d
else
  echo "File docker-compose.yaml tidak ditemukan di direktori saat ini."
fi

sleep 4
if docker ps --format '{{.Names}}' | grep -i -q "${app_name}"; then
  echo "✔ Kontainer ${app_name} berhasil berjalan (Running)!"
elif docker ps -a --format '{{.Names}}' | grep -i -q "${app_name}"; then
  echo "✔ Kontainer ${app_name} terdeteksi di docker ps -a!"
fi

echo "=== DEPLOYMENT COMPLETED SUCCESSFULLY ==="
    `.trim();
  }

  const sshResult = await executeSSHCommand(server, deployScript);
  const durationSeconds = (Date.now() - startTime) / 1000;

  if (sshResult.success) {
    logs.push(`[4/6] Artefak disalin & aplikasi ${app_name} berhasil dideploy.`);
    if (run_prisma_migrate) {
      logs.push(`[5/6] Prisma migration dieksekusi.`);
    }
    logs.push(`[6/6] Selesai deployment aplikasi ${app_name} di server ${server.name}! (Durasi: ${durationSeconds.toFixed(1)}s)`);
  } else {
    logs.push(`[ERR] Gagal menjalankan skrip deployment di server ${server.name}`);
    if (sshResult.stderr) {
      logs.push(`[ERR Details] ${sshResult.stderr}`);
    }
  }

  const fullLogs = logs.join('\n') + (sshResult.stdout ? `\n\n=== TERMINAL OUTPUT ===\n${sshResult.stdout}` : '') + (sshResult.stderr ? `\n\n=== STDERR ===\n${sshResult.stderr}` : '');

  // Record deployment history
  const historyId = await recordDeploymentHistory({
    pod_code: server.code,
    server_name: server.name,
    app_name,
    app_type: appType,
    environment,
    version,
    env_filename,
    run_prisma_migrate,
    status: sshResult.success ? 'success' : 'failed',
    duration_seconds: durationSeconds,
    logs: fullLogs,
    error_message: sshResult.success ? null : (sshResult.stderr || 'Deployment script exited with error'),
    deployed_by
  });

  // If success, upsert into pod_app_versions
  if (sshResult.success && server.code) {
    await upsertPodAppVersion({
      pod_code: server.code,
      app_name,
      app_type: appType,
      environment,
      current_version: version,
      last_deployment_id: historyId,
      status: 'active'
    });
  }

  return {
    success: sshResult.success,
    server_id: server.id,
    server_name: server.name,
    pod_code: server.code,
    host: server.host,
    app_name,
    env: environment,
    version,
    env_filename,
    run_prisma_migrate: Boolean(run_prisma_migrate),
    logs,
    output: sshResult.stdout,
    error: sshResult.stderr
  };
}

/**
 * Streaming Multi-POD & Multi-App Batch Deployment
 */
async function deployBatchPodAppServerStream({ server_ids, env, app_configs, onLog, deployed_by = 'Admin', bundle_id = null }) {
  const batchId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
  const environment = env || 'dev';
  const serverList = [];
  for (const sId of server_ids) {
    const s = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sId]);
    if (s) serverList.push(s);
  }

  if (serverList.length === 0) {
    throw new Error('Tidak ada server target POD v3 ditemukan');
  }

  onLog(`\n=== MEMULAI REAL-TIME BATCH DEPLOYMENT POD V3 (Batch ID: ${batchId}, ${serverList.length} SERVER, ${app_configs.length} APPS) ===\n`);

  let totalSuccess = 0;
  let totalFail = 0;

  await Promise.all(
    serverList.map(async (server) => {
      const serverStartTime = Date.now();
      onLog(`\n======================================================================`);
      onLog(`>>> [PARALLEL NODE START] PROSES DEPLOYMENT UNTUK SERVER: ${server.name} (Code: ${server.code || 'N/A'}, Host: ${server.host}:${server.port || 22})`);
      onLog(`======================================================================\n`);

      // Phase 1: Parallel downloads of all app artifacts from MinIO
      const downloadScript = generateBatchDownloadScript(server.name, app_configs, environment);

      // Phase 2: Sequential container/deb deployment per app
      let deployScriptPerApp = `echo "=== PHASE 2: Unzipping, Config & Deployment Execution ==="\n`;
      app_configs.forEach(cfg => {
        let envFileSnippet = '';
        if (cfg.env_filename) {
          const content = readEnvFileContent(cfg.env_filename);
          if (content) {
            envFileSnippet = `cat << 'EOF_ENV_${cfg.app_name}' > .env\n${content}\nEOF_ENV_${cfg.app_name}\necho "File .env (${cfg.env_filename}) berhasil ditulis."\n`;
          }
        }

        let prismaSnippet = '';
        if (cfg.run_prisma_migrate) {
          prismaSnippet = `echo "=== Running npx prisma migrate dev ==="\nif [ -d "prisma" ] || [ -f "schema.prisma" ]; then\n  npx prisma migrate dev --name "deploy" || npx prisma migrate deploy || echo "Peringatan: prisma migrate dev gagal"\nelif docker ps -a --format '{{.Names}}' | grep -q "${cfg.app_name}"; then\n  docker exec ${cfg.app_name} npx prisma migrate deploy 2>/dev/null || true\nfi\n`;
        }

        const isDebApp = cfg.app_name === 'big-screen' || cfg.app_name === 'small-screen';
        const isFrontend = cfg.app_type === 'frontend' || isDebApp || cfg.deploy_mode === 'webroot' || cfg.deploy_mode === 'pm2';
        const appDeployDir = isDebApp
          ? `/home/pod/workspace/Deployment/${cfg.app_name}-app`
          : `$HOME/${environment}`;

        deployScriptPerApp += `
echo ""
echo "----------------------------------------------------------------------"
echo ">>> [APLIKASI ${isFrontend ? 'FRONTEND SCREEN' : 'BACKEND'}] DEPLOYING ${cfg.app_name} (${cfg.version}) on ${server.name}..."
echo "----------------------------------------------------------------------"

# Navigate into app directory and version folder
cd "${appDeployDir}"
if [ -d "${cfg.version}/${cfg.version}" ]; then
  cd "${appDeployDir}/${cfg.version}/${cfg.version}"
elif [ -d "${cfg.version}" ]; then
  cd "${appDeployDir}/${cfg.version}"
fi

INSTALL_LOG="${appDeployDir}/${cfg.app_name}-deploy.log"
echo "=== LOG INSTALASI ${cfg.app_name} (${cfg.version}) - $(date) ===" > "$INSTALL_LOG"

echo "[JENKINS_STAGE:2:START:${server.name}:${cfg.app_name}]"
`;

        if (isDebApp) {
          deployScriptPerApp += generateDebDeploymentSnippet(server.name, cfg, "${INSTALL_LOG}");
        } else {
          deployScriptPerApp += generateDockerDeploymentSnippet(server.name, cfg, envFileSnippet, prismaSnippet, "${INSTALL_LOG}");
        }
      });

      const fullBatchScript = (downloadScript + deployScriptPerApp + `\necho "=== BATCH DEPLOYMENT SELESAI UNTUK SERVER ${server.name} ===\n"`).trim();

      let serverSuccessCount = 0;
      let serverFailCount = 0;
      let fullStreamLog = '';

      const res = await executeSSHCommandStream(server, fullBatchScript, (chunk) => {
        onLog(chunk);
        fullStreamLog += chunk;
        if (chunk.includes('STATUS_APP_SUCCESS:')) {
          serverSuccessCount++;
        }
        if (chunk.includes('STATUS_APP_FAIL:')) {
          serverFailCount++;
        }
      });

      const isServerOverallSuccess = res.success && serverFailCount === 0;
      if (serverSuccessCount === 0 && serverFailCount === 0) {
        if (res.success) {
          totalSuccess += app_configs.length;
        } else {
          totalFail += app_configs.length;
        }
      } else {
        totalSuccess += serverSuccessCount;
        totalFail += serverFailCount;
      }

      const serverDuration = (Date.now() - serverStartTime) / 1000;

      // Record deployment history and update app versions for each configured app on this server
      for (const cfg of app_configs) {
        const isDebApp = cfg.app_name === 'big-screen' || cfg.app_name === 'small-screen';
        const appType = isDebApp ? 'frontend' : (cfg.app_type || 'backend');
        const isThisAppSuccess = fullStreamLog.includes(`STATUS_APP_SUCCESS:${server.name}:${cfg.app_name}`) || (res.success && serverFailCount === 0);

        const historyId = await recordDeploymentHistory({
          batch_id: batchId,
          pod_code: server.code,
          server_name: server.name,
          app_name: cfg.app_name,
          app_type: appType,
          environment,
          version: cfg.version,
          env_filename: cfg.env_filename || null,
          run_prisma_migrate: Boolean(cfg.run_prisma_migrate),
          status: isThisAppSuccess ? 'success' : 'failed',
          duration_seconds: serverDuration / app_configs.length,
          logs: fullStreamLog,
          error_message: isThisAppSuccess ? null : `Batch deployment failed on ${server.name}`,
          deployed_by
        });

        if (isThisAppSuccess && server.code) {
          await upsertPodAppVersion({
            pod_code: server.code,
            app_name: cfg.app_name,
            app_type: appType,
            environment,
            current_version: cfg.version,
            last_deployment_id: historyId,
            status: 'active'
          });
        }
      }

      // If bundle_id provided and server succeeded, update pod_bundle_states
      if (server.code && bundle_id && serverFailCount === 0) {
        try {
          const { assignPodBundleState } = require('./bundleService');
          await assignPodBundleState({
            pod_code: server.code,
            bundle_id: Number(bundle_id),
            deployed_by
          });
          onLog(`[BUNDLE SYNC] Server ${server.name} (#${server.code}) status bundle berhasil diselaraskan ke Bundle #${bundle_id} (100% Synced)`);
        } catch (e) {
          console.warn('Failed to assign bundle state:', e.message);
        }
      }
    })
  );

  onLog(`\n======================================================================`);
  onLog(`=== SELURUH BATCH DEPLOYMENT SELESAI (Batch ID: ${batchId}) ===`);
  onLog(`Total Tugas Sukses: ${totalSuccess} | Total Tugas Gagal: ${totalFail}`);
  onLog(`======================================================================\n`);

  return {
    success: totalFail === 0,
    batchId,
    totalSuccess,
    totalFail,
    totalServers: serverList.length,
    totalApps: app_configs.length
  };
}

module.exports = {
  deployPodApp,
  deployBatchPodAppServerStream,
  recordDeploymentHistory,
  upsertPodAppVersion
};
