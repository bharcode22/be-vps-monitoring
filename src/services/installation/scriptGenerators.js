const { resolveMinioAppPath } = require('./minioService');

/**
 * Generate binary check snippet for MinIO client (avoids GNU Midnight Commander collision)
 */
function generateMinioClientResolutionSnippet() {
  return `
if [ -x "/usr/local/bin/mc" ] && /usr/local/bin/mc --version 2>&1 | grep -qi "minio"; then
  MC_CMD="/usr/local/bin/mc"
elif command -v mcli >/dev/null 2>&1; then
  MC_CMD="mcli"
elif command -v minio-client >/dev/null 2>&1; then
  MC_CMD="minio-client"
elif command -v mc >/dev/null 2>&1 && mc --version 2>&1 | grep -qi "minio"; then
  MC_CMD="mc"
else
  MC_CMD="mc"
fi
`;
}

/**
 * Generate download script snippet for batch parallel downloads
 */
function generateBatchDownloadScript(serverName, appConfigs, environment) {
  let downloadScript = `echo "[JENKINS_STAGE:1:START:${serverName}]"\necho "=== [STAGE 1/5] Clean & MinIO Parallel Download ==="\n`;
  downloadScript += generateMinioClientResolutionSnippet();

  appConfigs.forEach(cfg => {
    const minioAppPath = resolveMinioAppPath(cfg.app_name);
    const isDebApp = cfg.app_name === 'big-screen' || cfg.app_name === 'small-screen';
    const appDeployDir = isDebApp
      ? `/home/pod/workspace/Deployment/${cfg.app_name}-app`
      : `$HOME/${environment}`;

    downloadScript += `echo "  [$MC_CMD cp] Preparing directory ${appDeployDir}..."\n`;
    downloadScript += `mkdir -p "${appDeployDir}"\ncd "${appDeployDir}"\n`;
    downloadScript += `rm -rf dev-* 2>/dev/null || true\nrm -rf "${cfg.version}" 2>/dev/null || true\n`;
    downloadScript += `echo "  [$MC_CMD cp] Downloading ${cfg.app_name} (${cfg.version}) in background..."\n`;

    if (isDebApp) {
      downloadScript += `mkdir -p "${cfg.version}"\ncd "${appDeployDir}/${cfg.version}"\n`;
      downloadScript += `$MC_CMD cp --disable-multipart minio-deploy/deploybox/${minioAppPath}/${environment}/${cfg.version}/artifact-bundle-${cfg.version}.zip ./ &\n`;
    } else {
      downloadScript += `$MC_CMD cp --recursive minio-deploy/deploybox/${minioAppPath}/${environment}/${cfg.version} ./ &\n`;
    }
  });

  downloadScript += `echo "  [$MC_CMD cp] Menunggu seluruh download paralel selesai..."\nwait\necho "✔ [STAGE 1/5 SELESAI] All MinIO artifacts downloaded successfully!"\necho "[JENKINS_STAGE:1:END:${serverName}]"\n\n`;
  return downloadScript;
}

/**
 * Generate Debian Package deployment snippet (.deb for small-screen & big-screen)
 */
function generateDebDeploymentSnippet(serverName, cfg, installLog) {
  return `
echo "[STAGE 2/5] Meng-unzip arsip artefak bundle (${cfg.app_name})..." | tee -a "$INSTALL_LOG"
ZIP_FILE=$(ls artifact-bundle-*.zip 2>/dev/null | head -n 1)
if [ -z "$ZIP_FILE" ]; then
  ZIP_FILE=$(find . -maxdepth 2 -name "artifact-bundle-*.zip" -o -name "*.zip" 2>/dev/null | head -n 1)
fi
if [ -n "$ZIP_FILE" ]; then
  unzip -o "$ZIP_FILE" 2>&1 | tee -a "$INSTALL_LOG"
fi
DEB_FILE=$(ls *.deb 2>/dev/null | head -n 1)
if [ -z "$DEB_FILE" ]; then
  DEB_FILE=$(find . -maxdepth 2 -name "*.deb" 2>/dev/null | head -n 1)
fi
PKG_NAME="${cfg.app_name}"

if [ -n "$DEB_FILE" ]; then
  DETECTED_PKG=$(dpkg -I "$DEB_FILE" 2>/dev/null | grep "Package:" | cut -d: -f2 | tr -d '[:space:]')
  if [ -n "$DETECTED_PKG" ]; then PKG_NAME="$DETECTED_PKG"; fi
  echo "Paket Debian terverifikasi: $DEB_FILE (Nama paket: $PKG_NAME)" | tee -a "$INSTALL_LOG"
  dpkg -I "$DEB_FILE" 2>&1 | tee -a "$INSTALL_LOG" || true
else
  echo "❌ Paket Debian (.deb) tidak ditemukan!" | tee -a "$INSTALL_LOG"
fi
echo "[JENKINS_STAGE:2:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:3:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 3/5] Menghapus versi lama paket \$PKG_NAME dari sistem host OS..." | tee -a "$INSTALL_LOG"

# 1. Hentikan proses aplikasi yang sedang berjalan secara aman (tanpa menghentikan shell SSH deployment)
echo "Menghentikan proses $PKG_NAME yang sedang aktif di Host OS..." | tee -a "$INSTALL_LOG"
sudo systemctl stop "$PKG_NAME" 2>/dev/null || true
sudo systemctl stop "${cfg.app_name}" 2>/dev/null || true

# Gunakan kill exact binary name / /usr/bin/$PKG_NAME
EXACT_PIDS=$(pgrep -x "$PKG_NAME" 2>/dev/null || pgrep -x "${cfg.app_name}" 2>/dev/null || pgrep -f "^/usr/bin/$PKG_NAME" 2>/dev/null || true)
if [ -n "$EXACT_PIDS" ]; then
  echo "Menghentikan PID aktif: $EXACT_PIDS..." | tee -a "$INSTALL_LOG"
  sudo kill -9 $EXACT_PIDS 2>/dev/null || true
fi

# 2. Periksa & hapus paket terpasang sebelumnya via dpkg
TARGET_PKGS=("\$PKG_NAME" "${cfg.app_name}" "${cfg.app_name}-app")
for P in "\${TARGET_PKGS[@]}"; do
  if dpkg -l | grep -q "^ii.*$P"; then
    CURR_VER=$(dpkg-query -W -f='\${Version}' $P 2>/dev/null || echo "unknown")
    echo "📦 Versi terpasang ditemukan: $P (versi $CURR_VER). Menghapus paket..." | tee -a "$INSTALL_LOG"
    sudo dpkg -r $P 2>&1 | tee -a "$INSTALL_LOG" || sudo dpkg --purge $P 2>&1 | tee -a "$INSTALL_LOG" || true
    if dpkg -l | grep -q "^ii.*$P"; then
      echo "⚠️ Mencoba force purge untuk $P..." | tee -a "$INSTALL_LOG"
      sudo dpkg --purge --force-all $P 2>&1 | tee -a "$INSTALL_LOG" || true
    fi
  fi
done

# 3. Bersihkan file sisa di direktori sistem /usr
echo "Membersihkan file sisa di direktori sistem..." | tee -a "$INSTALL_LOG"
sudo find /usr -name "*${cfg.app_name}*" -type f 2>/dev/null | head -10 2>&1 | tee -a "$INSTALL_LOG" || true
echo "✔ Pembersihan versi lama selesai." | tee -a "$INSTALL_LOG"
echo "[JENKINS_STAGE:3:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:4:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 4/5] Meng-install paket Debian baru (\$PKG_NAME)..." | tee -a "$INSTALL_LOG"
if [ -n "$DEB_FILE" ]; then
  sudo dpkg -i "$DEB_FILE" 2>&1 | tee -a "$INSTALL_LOG" || (sudo apt-get update && sudo apt-get install -f -y 2>&1 | tee -a "$INSTALL_LOG")
else
  echo "❌ File .deb tidak ditemukan di direktori saat ini!" | tee -a "$INSTALL_LOG"
fi
echo "[JENKINS_STAGE:4:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:5:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 5/5] Memverifikasi status instalasi Host OS (\$PKG_NAME)..." | tee -a "$INSTALL_LOG"
dpkg -l | grep "^ii.*\$PKG_NAME" 2>&1 | tee -a "$INSTALL_LOG" || true
INSTALLED_VER=$(dpkg-query -W -f='\${Version}' \$PKG_NAME 2>/dev/null || echo "NOT_FOUND")

if [ "$INSTALLED_VER" != "NOT_FOUND" ]; then
  echo "✔ [SUCCESS] Aplikasi Host OS \$PKG_NAME (versi \${INSTALLED_VER}) berhasil terpasang di server ${serverName}!" | tee -a "$INSTALL_LOG"
  dpkg --verify \$PKG_NAME 2>&1 | tee -a "$INSTALL_LOG" || true
  echo "STATUS_APP_SUCCESS:${cfg.app_name}:${serverName}"
else
  echo "❌ [ERROR] Aplikasi Host OS \$PKG_NAME gagal terpasang di ${serverName}!" | tee -a "$INSTALL_LOG"
  echo "STATUS_APP_FAIL:${cfg.app_name}:${serverName}"
fi
echo "Log lengkap tersimpan di server: $INSTALL_LOG"
echo "[JENKINS_STAGE:5:END:${serverName}:${cfg.app_name}]"
`;
}

/**
 * Generate Docker deployment snippet for backend microservices
 */
function generateDockerDeploymentSnippet(serverName, cfg, envFileSnippet, prismaSnippet, installLog) {
  return `
echo "[STAGE 2/5] Meng-unzip arsip artefak (${cfg.app_name})..."
ZIP_FILE=$(ls artifact-bundle-*.zip 2>/dev/null | head -n 1)
if [ -z "$ZIP_FILE" ]; then
  ZIP_FILE=$(find . -maxdepth 2 -name "artifact-bundle-*.zip" -o -name "*.zip" 2>/dev/null | head -n 1)
fi
if [ -n "$ZIP_FILE" ]; then
  echo "Meng-unzip artefak bundle: $ZIP_FILE..." | tee -a "$INSTALL_LOG"
  unzip -o "$ZIP_FILE" 2>&1 | tee -a "$INSTALL_LOG"
fi
echo "[JENKINS_STAGE:2:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:3:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 3/5] Meng-inject file .env & Prisma Migration (${cfg.app_name})..."
${envFileSnippet}
${prismaSnippet}
echo "[JENKINS_STAGE:3:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:4:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 4/5] Memuat Docker Image tarball & Pre-creating Host Volume Directories (${cfg.app_name})..."

mkdir -p /home/pod/Documents/tokens /home/pod/videos /home/pod/images /home/pod/sounds /home/pod/logs /home/pod/flow-editor 2>/dev/null || true
chmod -R 777 /home/pod/Documents/tokens /home/pod/videos /home/pod/images /home/pod/sounds /home/pod/logs /home/pod/flow-editor 2>/dev/null || true

COMPOSE_FILE=$(ls docker-compose.yaml docker-compose.yml docker-compose.prod.yaml docker-compose.prod.yml compose.yaml compose.yml 2>/dev/null | head -n 1)
if [ -z "$COMPOSE_FILE" ]; then
  COMPOSE_FILE=$(find . -maxdepth 2 -name "docker-compose*.y*ml" -o -name "compose*.y*ml" 2>/dev/null | head -n 1)
fi

if [ -n "$COMPOSE_FILE" ]; then
  echo "Menghentikan service via compose: $COMPOSE_FILE..." | tee -a "$INSTALL_LOG"
  docker compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$INSTALL_LOG" || docker-compose -f "$COMPOSE_FILE" down 2>&1 | tee -a "$INSTALL_LOG" || true
fi
docker stop ${cfg.app_name} 2>/dev/null || true
docker rm ${cfg.app_name} 2>/dev/null || true
docker network prune -f 2>/dev/null || true
docker image prune -f 2>/dev/null || true

IMAGE_FILE=$(ls image-*.tar.gz 2>/dev/null | head -n 1)
if [ -z "$IMAGE_FILE" ]; then
  IMAGE_FILE=$(find . -maxdepth 2 -name "image-*.tar.gz" -o -name "*.tar.gz" 2>/dev/null | head -n 1)
fi

if [ -n "$IMAGE_FILE" ]; then
  echo "  [docker load] Loading Docker Image from $IMAGE_FILE..." | tee -a "$INSTALL_LOG"
  docker load < "$IMAGE_FILE" 2>&1 | tee -a "$INSTALL_LOG"
fi
echo "[JENKINS_STAGE:4:END:${serverName}:${cfg.app_name}]"

echo "[JENKINS_STAGE:5:START:${serverName}:${cfg.app_name}]"
echo "[STAGE 5/5] Menjalankan Docker Compose Up (${cfg.app_name})..."
if [ -n "$COMPOSE_FILE" ]; then
  echo "Menjalankan Docker Compose Up ($COMPOSE_FILE)..." | tee -a "$INSTALL_LOG"
  docker compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$INSTALL_LOG" || docker-compose -f "$COMPOSE_FILE" up -d 2>&1 | tee -a "$INSTALL_LOG"
else
  echo "Peringatan: File docker-compose.yaml tidak ditemukan di $(pwd)" | tee -a "$INSTALL_LOG"
fi

echo "Menunggu inisialisasi kontainer 4 detik..."
sleep 4

if docker ps --format '{{.Names}}' | grep -i -q "${cfg.app_name}"; then
  echo "✔ [SUCCESS] Kontainer ${cfg.app_name} berhasil berjalan (Running) di server ${serverName}!" | tee -a "$INSTALL_LOG"
  echo "STATUS_APP_SUCCESS:${cfg.app_name}:${serverName}"
elif docker ps -a --format '{{.Names}}' | grep -i -q "${cfg.app_name}"; then
  CONTAINER_STATUS=$(docker ps -a --filter "name=${cfg.app_name}" --format '{{.Status}}' | head -n 1)
  echo "✔ [SUCCESS] Kontainer ${cfg.app_name} terdeteksi di docker ps -a (Status: $CONTAINER_STATUS) di server ${serverName}!" | tee -a "$INSTALL_LOG"
  echo "STATUS_APP_SUCCESS:${cfg.app_name}:${serverName}"
elif [ -n "$COMPOSE_FILE" ] && (docker compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -i -q "Up" || docker-compose -f "$COMPOSE_FILE" ps 2>/dev/null | grep -i -q "Up"); then
  echo "✔ [SUCCESS] Kontainer ${cfg.app_name} berhasil berjalan via compose di server ${serverName}!" | tee -a "$INSTALL_LOG"
  echo "STATUS_APP_SUCCESS:${cfg.app_name}:${serverName}"
else
  echo "❌ [ERROR] Kontainer ${cfg.app_name} tidak terdeteksi di docker ps / docker ps -a!" | tee -a "$INSTALL_LOG"
  echo "--- DIAGNOSTIK DOCKER PS -A (${cfg.app_name}) ---" | tee -a "$INSTALL_LOG"
  docker ps -a | grep -i "${cfg.app_name}" 2>&1 | tee -a "$INSTALL_LOG" || true
  if [ -n "$COMPOSE_FILE" ]; then
    echo "--- DIAGNOSTIK DOCKER COMPOSE PS (${cfg.app_name}) ---" | tee -a "$INSTALL_LOG"
    docker compose -f "$COMPOSE_FILE" ps 2>&1 | tee -a "$INSTALL_LOG" || true
    echo "--- DIAGNOSTIK DOCKER COMPOSE LOGS (${cfg.app_name}) ---" | tee -a "$INSTALL_LOG"
    docker compose -f "$COMPOSE_FILE" logs --tail 30 2>&1 | tee -a "$INSTALL_LOG" || true
  fi
  echo "--------------------------------------------------" | tee -a "$INSTALL_LOG"
  echo "STATUS_APP_FAIL:${cfg.app_name}:${serverName}"
fi
echo "Log lengkap tersimpan di server: $INSTALL_LOG"
echo "[JENKINS_STAGE:5:END:${serverName}:${cfg.app_name}]"
`;
}

module.exports = {
  generateMinioClientResolutionSnippet,
  generateBatchDownloadScript,
  generateDebDeploymentSnippet,
  generateDockerDeploymentSnippet
};
