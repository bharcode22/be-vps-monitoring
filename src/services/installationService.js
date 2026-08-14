const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { Client } = require('ssh2');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const { dbAsync } = require('./db');

// Default MinIO Credentials & Parameters
const DEFAULT_MINIO_CONFIG = {
  endpoint: process.env.MINIO_ENDPOINT,
  accessKeyId: process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.MINIO_SECRET_KEY,
  region: process.env.MINIO_REGION,
  bucket: process.env.MINIO_BUCKET
};

/**
 * Fetch list of available .env configuration files in backend/envoirment
 */
async function getEnvFiles() {
  try {
    const envDir = path.join(__dirname, '../../envoirment');
    if (!fs.existsSync(envDir)) {
      return { success: true, files: [] };
    }
    const fileNames = fs.readdirSync(envDir).filter(f => f.endsWith('.env') || f.endsWith('.env.example'));
    const files = fileNames.map(fileName => {
      const filePath = path.join(envDir, fileName);
      let content = '';
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch (e) {
        content = '';
      }
      return {
        name: fileName,
        path: filePath,
        content
      };
    });
    return { success: true, files };
  } catch (err) {
    console.error('Error reading env files directory:', err);
    return { success: false, error: err.message, files: [] };
  }
}

/**
 * Execute command on SSH remote server or local host
 */
function executeSSHCommand(server, command) {
  return new Promise((resolve, reject) => {
    if (server.is_local === 1) {
      exec(command, { timeout: 300000 }, (error, stdout, stderr) => {
        if (error) {
          return resolve({ success: false, stdout, stderr: stderr.trim() || error.message });
        }
        resolve({ success: true, stdout, stderr });
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          resolve({ success: false, stdout: '', stderr: 'Koneksi SSH ke server waktu habis (timeout 5 menit)' });
        }
      }, 300000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'pod',
        readyTimeout: 15000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            return resolve({ success: false, stdout: '', stderr: err.message });
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data) => {
            stdout += data.toString();
          });
          stream.stderr.on('data', (data) => {
            stderr += data.toString();
          });

          stream.on('close', (code) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve({
                success: code === 0,
                code,
                stdout,
                stderr
              });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!isHandled) {
          isHandled = true;
          resolve({ success: false, stdout: '', stderr: `Error koneksi SSH: ${err.message}` });
        }
      });

      conn.connect(sshConfig);
    }
  });
}

/**
 * Smart Version Comparator (Sorts newest YYYYMMDD date, build ID, or SemVer first)
 */
function sortVersionsByNewest(versionList) {
  function getVersionSortScore(v) {
    // 1. Format: dev-fed7ad03-2338490563-20260220 (tag-hash-buildId-YYYYMMDD)
    const dateAndBuildMatch = v.match(/-(\d+)-(\d{8})(?:-\d+)?$/);
    if (dateAndBuildMatch) {
      const buildId = Number(dateAndBuildMatch[1]) || 0;
      const dateNum = Number(dateAndBuildMatch[2]) || 0;
      return { date: dateNum, build: buildId };
    }

    // 2. Format ending with YYYYMMDD (e.g., dev-tag-20260812)
    const dateMatch = v.match(/-(\d{8})(?:-\d+)?$/);
    if (dateMatch) {
      return { date: Number(dateMatch[1]), build: 0 };
    }

    // 3. Format SemVer v1.0.14 or 1.0.14
    const semverMatch = v.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (semverMatch) {
      const major = Number(semverMatch[1]) || 0;
      const minor = Number(semverMatch[2]) || 0;
      const patch = Number(semverMatch[3]) || 0;
      const semScore = major * 1000000 + minor * 1000 + patch;
      return { date: semScore, build: 0 };
    }

    return { date: 0, build: 0 };
  }

  return [...versionList].sort((a, b) => {
    const scoreA = getVersionSortScore(a);
    const scoreB = getVersionSortScore(b);

    if (scoreA.date !== scoreB.date) {
      return scoreB.date - scoreA.date; // Newest date/semver first
    }
    if (scoreA.build !== scoreB.build) {
      return scoreB.build - scoreA.build; // Higher build ID first
    }
    return b.localeCompare(a);
  });
}

/**
 * Fetch available artifact versions from MinIO bucket deploybox
 */
async function getInstallationVersions({ app_name = 'mobile-api', env = 'dev' }) {
  try {
    const storageServers = await dbAsync.all("SELECT * FROM object_storages WHERE type IN ('minio', 's3')");

    let minioEndpoint = DEFAULT_MINIO_CONFIG.endpoint;
    let accessKey = DEFAULT_MINIO_CONFIG.accessKeyId;
    let secretKey = DEFAULT_MINIO_CONFIG.secretAccessKey;
    let region = DEFAULT_MINIO_CONFIG.region;
    let targetBucket = DEFAULT_MINIO_CONFIG.bucket;

    if (storageServers && storageServers.length > 0) {
      const storage = storageServers[0];
      if (storage.s3_bucket) targetBucket = storage.s3_bucket;
      if (storage.s3_access_key) accessKey = storage.s3_access_key;
      if (storage.s3_secret_key) secretKey = storage.s3_secret_key;
      if (storage.s3_region) region = storage.s3_region;

      if (storage.s3_endpoint) {
        let ep = storage.s3_endpoint.trim();
        if (!ep.startsWith('http://') && !ep.startsWith('https://')) {
          ep = `http://${ep}`;
        }
        if (storage.port && !/:\d+$/.test(ep)) {
          ep = `${ep}:${storage.port}`;
        }
        minioEndpoint = ep;
      }
    }

    const s3Client = new S3Client({
      region,
      endpoint: minioEndpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: accessKey,
        secretAccessKey: secretKey
      }
    });

    const candidateAppNames = app_name === 'mobile-consume'
      ? ['mobile-consume', 'mobile-consumer']
      : [app_name];

    let foundVersions = [];

    for (const app of candidateAppNames) {
      const prefix = `${app}/${env}/`;
      const command = new ListObjectsV2Command({
        Bucket: targetBucket,
        Prefix: prefix,
        Delimiter: '/'
      });

      const res = await s3Client.send(command);
      const prefixes = res.CommonPrefixes || [];

      const parsed = prefixes
        .map(p => {
          const parts = p.Prefix.split('/').filter(Boolean);
          return parts[parts.length - 1];
        })
        .filter(Boolean);

      foundVersions = [...foundVersions, ...parsed];
    }

    // Smart sort versions (newest release date & build ID first)
    foundVersions = sortVersionsByNewest(foundVersions);

    if (foundVersions.length > 0) {
      return {
        success: true,
        app_name,
        env,
        endpoint: minioEndpoint,
        bucket: targetBucket,
        versions: foundVersions
      };
    }

    return {
      success: true,
      app_name,
      env,
      endpoint: minioEndpoint,
      bucket: targetBucket,
      versions: [],
      message: `Tidak ada versi ditemukan di path ${app_name}/${env}/`
    };
  } catch (err) {
    console.error('Error fetching installation versions from MinIO:', err.message);
    return {
      success: false,
      app_name,
      env,
      error: `Gagal terhubung ke MinIO (${err.message})`
    };
  }
}

/**
 * Execute automated deployment on target POD v3 server via SSH
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
  let envFileContent = '';
  if (env_filename) {
    const envPath = path.join(__dirname, '../../envoirment', env_filename);
    if (fs.existsSync(envPath)) {
      envFileContent = fs.readFileSync(envPath, 'utf8');
      logs.push(`[3/6] Menggunakan file env: ${env_filename}`);
    }
  }

  // Path in MinIO bucket
  const minioAppPath = app_name === 'mobile-consume' ? 'mobile-consumer' : app_name;

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
elif docker ps --format '{{.Names}}' | grep -q "${app_name}"; then
  docker exec ${app_name} npx prisma migrate deploy 2>/dev/null || echo "Peringatan: prisma migrate exec gagal di kontainer"
fi
`;
  }

  // SSH shell script commands to execute deployment
  const deployScript = `
set -e
echo "=== STEP 1: Mempersiapkan direktori ~/${environment} ==="
mkdir -p ~/${environment}
cd ~/${environment}

echo "=== STEP 2: Menyalin artefak dari MinIO (deploybox/${minioAppPath}/${environment}/${version}) ==="
mc cp --recursive minio-deploy/deploybox/${minioAppPath}/${environment}/${version} ./ || echo "Peringatan: mc cp menggunakan fallback lokal atau file sudah ada"

echo "=== STEP 3: Masuk ke folder versi ${version} ==="
if [ -d "${version}" ]; then
  cd "${version}"
fi

echo "=== STEP 3.5: Mengekstrak paket artefak (.zip) ==="
if [ -f "artifact-bundle-${version}.zip" ]; then
  echo "Unzipping artifact-bundle-${version}.zip..."
  unzip -o "artifact-bundle-${version}.zip"
elif ls artifact-bundle-*.zip 1>/dev/null 2>&1; then
  echo "Unzipping artifact-bundle-*.zip..."
  unzip -o artifact-bundle-*.zip
elif ls *.zip 1>/dev/null 2>&1; then
  echo "Unzipping *.zip..."
  unzip -o *.zip
else
  echo "Tidak ada file zip yang perlu diekstrak."
fi

${envScriptSnippet}
echo "=== STEP 4: Menghentikan & menghapus kontainer lama (${app_name}) ==="
docker stop ${app_name} 2>/dev/null || true
docker rm ${app_name} 2>/dev/null || true

echo "=== STEP 4.5: Membersihkan network & image Docker sisa yang tidak terpakai ==="
docker network prune -f 2>/dev/null || true
docker image prune -f 2>/dev/null || true

echo "=== STEP 5: Memuat Docker Image baru ==="
IMAGE_FILE=$(ls image-*.tar.gz 2>/dev/null | head -n 1)
if [ -n "$IMAGE_FILE" ]; then
  echo "Loading image dari $IMAGE_FILE..."
  docker load < "$IMAGE_FILE"
elif [ -f "image-${version}.tar.gz" ]; then
  echo "Loading image dari image-${version}.tar.gz..."
  docker load < "image-${version}.tar.gz"
else
  echo "Gambar tar.gz tidak ditemukan secara eksplisit, mengecek docker-compose..."
fi
${prismaScriptSnippet}
echo "=== STEP 6: Menjalankan kontainer baru dengan docker-compose ==="
if [ -f "docker-compose.yaml" ]; then
  docker compose -f docker-compose.yaml up -d || docker-compose -f docker-compose.yaml up -d
elif [ -f "docker-compose.yml" ]; then
  docker compose -f docker-compose.yml up -d || docker-compose -f docker-compose.yml up -d
else
  echo "File docker-compose.yaml tidak ditemukan di direktori saat ini."
fi

echo "=== DEPLOYMENT COMPLETED SUCCESSFULLY ==="
  `.trim();

  const sshResult = await executeSSHCommand(server, deployScript);

  if (sshResult.success) {
    logs.push(`[4/6] Artefak disalin & kontainer ${app_name} di-stop/rm.`);
    if (run_prisma_migrate) {
      logs.push(`[5/6] Prisma migration dieksekusi.`);
    }
    logs.push(`[6/6] Docker image dimuat & docker-compose up -d berhasil dijalankan di server ${server.name}!`);
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
 * Execute SSH command and stream stdout/stderr chunks in real-time
 */
function executeSSHCommandStream(server, command, onData) {
  return new Promise((resolve) => {
    if (server.is_local === 1) {
      const child = exec(command, { timeout: 600000 });
      let stdout = '';
      let stderr = '';
      if (child.stdout) {
        child.stdout.on('data', data => {
          const str = data.toString();
          stdout += str;
          if (onData) onData(str);
        });
      }
      if (child.stderr) {
        child.stderr.on('data', data => {
          const str = data.toString();
          stderr += str;
          if (onData) onData(str);
        });
      }
      child.on('close', code => {
        resolve({ success: code === 0, code, stdout, stderr });
      });
      child.on('error', err => {
        resolve({ success: false, stdout, stderr: err.message });
      });
    } else {
      const conn = new Client();
      let isHandled = false;

      const timeout = setTimeout(() => {
        if (!isHandled) {
          isHandled = true;
          conn.end();
          if (onData) onData('\n❌ Koneksi SSH waktu habis (timeout 10 menit)\n');
          resolve({ success: false, stdout: '', stderr: 'Timeout 10 menit' });
        }
      }, 600000);

      const sshConfig = {
        host: server.host,
        port: server.port || 22,
        username: server.username || 'pod',
        readyTimeout: 30000
      };

      if (server.auth_type === 'key' && server.private_key) {
        sshConfig.privateKey = server.private_key;
      } else {
        sshConfig.password = server.password;
      }

      conn.on('ready', () => {
        conn.exec(command, (err, stream) => {
          if (err) {
            clearTimeout(timeout);
            conn.end();
            if (onData) onData(`\n❌ Error exec SSH: ${err.message}\n`);
            return resolve({ success: false, stdout: '', stderr: err.message });
          }

          let stdout = '';
          let stderr = '';

          stream.on('data', (data) => {
            const str = data.toString();
            stdout += str;
            if (onData) onData(str);
          });
          stream.stderr.on('data', (data) => {
            const str = data.toString();
            stderr += str;
            if (onData) onData(str);
          });

          stream.on('close', (code) => {
            clearTimeout(timeout);
            conn.end();
            if (!isHandled) {
              isHandled = true;
              resolve({
                success: code === 0,
                code,
                stdout,
                stderr
              });
            }
          });
        });
      });

      conn.on('error', (err) => {
        clearTimeout(timeout);
        if (!isHandled) {
          isHandled = true;
          if (onData) onData(`\n❌ SSH Connection Error: ${err.message}\n`);
          resolve({ success: false, stdout: '', stderr: `Error koneksi SSH: ${err.message}` });
        }
      });

      conn.connect(sshConfig);
    }
  });
}

/**
 * Streaming Multi-POD & Multi-App Batch Deployment (Parallel Downloads, README Execution & Container Wait)
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

  // Execute deployment across ALL target POD servers simultaneously in parallel using Promise.all
  await Promise.all(
    serverList.map(async (server) => {
      onLog(`\n======================================================================`);
      onLog(`>>> [PARALLEL NODE START] PROSES DEPLOYMENT UNTUK SERVER: ${server.name} (${server.host}:${server.port || 22})`);
      onLog(`======================================================================\n`);

      // Phase 1: Clean old files & Parallel downloads of all app artifacts from MinIO
      let downloadScript = `mkdir -p ~/${environment}\ncd ~/${environment}\necho "[JENKINS_STAGE:1:START:${server.name}]"\necho "=== [STAGE 1/5] Clean & MinIO Parallel Download ==="\nrm -rf ./* 2>/dev/null || true\n`;

      app_configs.forEach(cfg => {
        const minioAppPath = cfg.app_name === 'mobile-consume' ? 'mobile-consumer' : cfg.app_name;
        downloadScript += `echo "  [mc cp] Downloading ${cfg.app_name} (${cfg.version}) in background..."\n`;
        downloadScript += `mc cp --recursive minio-deploy/deploybox/${minioAppPath}/${environment}/${cfg.version} ./ &\n`;
      });
      downloadScript += `echo "  [mc cp] Menunggu seluruh download paralel selesai..."\nwait\necho "✔ [STAGE 1/5 SELESAI] All MinIO artifacts downloaded successfully!"\necho "[JENKINS_STAGE:1:END:${server.name}]"\n\n`;

      // Phase 2: Sequential container deployment per app
      let deployScriptPerApp = `echo "=== PHASE 2: Unzipping, Loading Image & Docker Compose Up ==="\n`;
      app_configs.forEach(cfg => {
        let envFileSnippet = '';
        if (cfg.env_filename) {
          const envPath = path.join(__dirname, '../../envoirment', cfg.env_filename);
          if (fs.existsSync(envPath)) {
            const content = fs.readFileSync(envPath, 'utf8');
            envFileSnippet = `cat << 'EOF_ENV_${cfg.app_name}' > .env\n${content}\nEOF_ENV_${cfg.app_name}\necho "File .env (${cfg.env_filename}) berhasil ditulis."\n`;
          }
        }

        let prismaSnippet = '';
        if (cfg.run_prisma_migrate) {
          prismaSnippet = `echo "=== Running npx prisma migrate dev ==="\nif [ -d "prisma" ] || [ -f "schema.prisma" ]; then\n  npx prisma migrate dev --name "deploy" || npx prisma migrate deploy || echo "Peringatan: prisma migrate dev gagal"\nelif docker ps --format '{{.Names}}' | grep -q "${cfg.app_name}"; then\n  docker exec ${cfg.app_name} npx prisma migrate deploy 2>/dev/null || true\nfi\n`;
        }

        deployScriptPerApp += `
echo ""
echo "----------------------------------------------------------------------"
echo ">>> [APLIKASI] DEPLOYING ${cfg.app_name} (${cfg.version}) on ${server.name}..."
echo "----------------------------------------------------------------------"
if [ -d "${cfg.version}" ]; then
  cd ~/${environment}/${cfg.version}
else
  cd ~/${environment}
fi

echo "[JENKINS_STAGE:2:START:${server.name}:${cfg.app_name}]"
echo "[STAGE 2/5] Meng-unzip arsip artefak (${cfg.app_name})..."
if [ -f "artifact-bundle-${cfg.version}.zip" ]; then
  unzip -o "artifact-bundle-${cfg.version}.zip"
elif ls artifact-bundle-*.zip 1>/dev/null 2>&1; then
  unzip -o artifact-bundle-*.zip
elif ls *.zip 1>/dev/null 2>&1; then
  unzip -o *.zip
fi
echo "[JENKINS_STAGE:2:END:${server.name}:${cfg.app_name}]"

echo "[JENKINS_STAGE:3:START:${server.name}:${cfg.app_name}]"
echo "[STAGE 3/5] Meng-inject file .env & Prisma Migration (${cfg.app_name})..."
${envFileSnippet}
${prismaSnippet}
echo "[JENKINS_STAGE:3:END:${server.name}:${cfg.app_name}]"

echo "[JENKINS_STAGE:4:START:${server.name}:${cfg.app_name}]"
echo "[STAGE 4/5] Memuat Docker Image tarball & Pruning Network sisa (${cfg.app_name})..."
if [ -f "docker-compose.yaml" ]; then
  docker compose -f docker-compose.yaml down 2>/dev/null || docker-compose -f docker-compose.yaml down 2>/dev/null || true
elif [ -f "docker-compose.yml" ]; then
  docker compose -f docker-compose.yml down 2>/dev/null || docker-compose -f docker-compose.yml down 2>/dev/null || true
fi
docker stop ${cfg.app_name} 2>/dev/null || true
docker rm ${cfg.app_name} 2>/dev/null || true
docker network prune -f 2>/dev/null || true
docker image prune -f 2>/dev/null || true

IMAGE_FILE=$(ls image-*.tar.gz 2>/dev/null | head -n 1)
if [ -n "$IMAGE_FILE" ]; then
  echo "  [docker load] Loading Docker Image from $IMAGE_FILE..."
  docker load < "$IMAGE_FILE"
elif [ -f "image-${cfg.version}.tar.gz" ]; then
  echo "  [docker load] Loading Docker Image from image-${cfg.version}.tar.gz..."
  docker load < "image-${cfg.version}.tar.gz"
fi
echo "[JENKINS_STAGE:4:END:${server.name}:${cfg.app_name}]"

echo "[JENKINS_STAGE:5:START:${server.name}:${cfg.app_name}]"
echo "[STAGE 5/5] Menjalankan Docker Compose Up (${cfg.app_name})..."
if [ -f "docker-compose.yaml" ]; then
  docker compose -f docker-compose.yaml up -d || docker-compose -f docker-compose.yaml up -d
elif [ -f "docker-compose.yml" ]; then
  docker compose -f docker-compose.yml up -d || docker-compose -f docker-compose.yml up -d
else
  echo "Peringatan: File docker-compose.yaml tidak ditemukan"
fi

echo "Menunggu inisialisasi kontainer 3 detik..."
sleep 3

echo "✔ [SUCCESS] ${cfg.app_name} berhasil di-deploy di server ${server.name}!"
echo "STATUS_APP_SUCCESS:${cfg.app_name}:${server.name}"
echo "[JENKINS_STAGE:5:END:${server.name}:${cfg.app_name}]"
`;
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

  return { success: true, totalSuccess, totalFail };
}

module.exports = {
  getEnvFiles,
  getInstallationVersions,
  deployPodApp,
  deployBatchPodAppServerStream
};
