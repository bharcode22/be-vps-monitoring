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
 * Execute automated deployment on a single target POD v3 server via SSH
 */
async function deployPodApp({ server_id, app_name, env, version, env_filename, run_prisma_migrate }) {
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
  const isDebApp = app_name === 'big-screen' || app_name === 'small-screen';
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

  if (sshResult.success) {
    logs.push(`[4/6] Artefak disalin & aplikasi ${app_name} berhasil dideploy.`);
    if (run_prisma_migrate) {
      logs.push(`[5/6] Prisma migration dieksekusi.`);
    }
    logs.push(`[6/6] Selesai deployment aplikasi ${app_name} di server ${server.name}!`);
  } else {
    logs.push(`[ERR] Gagal menjalankan skrip deployment di server ${server.name}`);
    if (sshResult.stderr) {
      logs.push(`[ERR Details] ${sshResult.stderr}`);
    }
  }

  return {
    success: sshResult.success,
    server_id: server.id,
    server_name: server.name,
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
async function deployBatchPodAppServerStream({ server_ids, env, app_configs, onLog }) {
  const environment = env || 'dev';
  const serverList = [];
  for (const sId of server_ids) {
    const s = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [sId]);
    if (s) serverList.push(s);
  }

  if (serverList.length === 0) {
    throw new Error('Tidak ada server target POD v3 ditemukan');
  }

  onLog(`\n=== MEMULAI REAL-TIME BATCH DEPLOYMENT POD V3 (${serverList.length} SERVER, ${app_configs.length} APPS) ===\n`);

  let totalSuccess = 0;
  let totalFail = 0;

  await Promise.all(
    serverList.map(async (server) => {
      onLog(`\n======================================================================`);
      onLog(`>>> [PARALLEL NODE START] PROSES DEPLOYMENT UNTUK SERVER: ${server.name} (${server.host}:${server.port || 22})`);
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

      const res = await executeSSHCommandStream(server, fullBatchScript, (chunk) => {
        onLog(chunk);
        if (chunk.includes('STATUS_APP_SUCCESS:')) {
          serverSuccessCount++;
        }
        if (chunk.includes('STATUS_APP_FAIL:')) {
          serverFailCount++;
        }
      });

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
    })
  );

  onLog(`\n======================================================================`);
  onLog(`=== SELURUH BATCH DEPLOYMENT SELESAI ===`);
  onLog(`Total Tugas Sukses: ${totalSuccess} | Total Tugas Gagal: ${totalFail}`);
  onLog(`======================================================================\n`);

  return {
    success: totalFail === 0,
    totalSuccess,
    totalFail,
    totalServers: serverList.length,
    totalApps: app_configs.length
  };
}

module.exports = {
  deployPodApp,
  deployBatchPodAppServerStream
};
