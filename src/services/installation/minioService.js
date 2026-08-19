const { S3Client, ListObjectsV2Command, DeleteObjectsCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { dbAsync } = require('../db');

// Default MinIO Credentials & Parameters
const DEFAULT_MINIO_CONFIG = {
  endpoint: process.env.MINIO_ENDPOINT,
  accessKeyId: process.env.MINIO_ACCESS_KEY,
  secretAccessKey: process.env.MINIO_SECRET_KEY,
  region: process.env.MINIO_REGION,
  bucket: process.env.MINIO_BUCKET
};

/**
 * Smart Version Comparator (Sorts newest YYYYMMDD date, build ID, or SemVer first)
 */
function sortVersionsByNewest(versionList) {
  function getVersionSortScore(v) {
    const verStr = typeof v === 'object' ? (v.version || v.name || '') : String(v);

    // 1. Format: dev-fed7ad03-2338490563-20260220 (tag-hash-buildId-YYYYMMDD)
    const dateAndBuildMatch = verStr.match(/-(\d+)-(\d{8})(?:-\d+)?$/);
    if (dateAndBuildMatch) {
      const buildId = Number(dateAndBuildMatch[1]) || 0;
      const dateNum = Number(dateAndBuildMatch[2]) || 0;
      return { date: dateNum, build: buildId };
    }

    // 2. Format ending with YYYYMMDD (e.g., dev-tag-20260812)
    const dateMatch = verStr.match(/-(\d{8})(?:-\d+)?$/);
    if (dateMatch) {
      return { date: Number(dateMatch[1]), build: 0 };
    }

    // 3. Format SemVer v1.0.14 or 1.0.14
    const semverMatch = verStr.match(/^v?(\d+)\.(\d+)\.(\d+)/);
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
    const strA = typeof a === 'object' ? (a.version || a.name || '') : String(a);
    const strB = typeof b === 'object' ? (b.version || b.name || '') : String(b);
    return strB.localeCompare(strA);
  });
}

/**
 * Resolve MinIO relative path for a given application
 */
function resolveMinioAppPath(appName) {
  if (appName === 'big-screen') {
    return 'Screen-Apps/big-screen-app';
  } else if (appName === 'small-screen') {
    return 'Screen-Apps/small-screen-app';
  } else if (appName === 'mobile-consume') {
    return 'mobile-consumer';
  }
  return appName;
}

/**
 * Helper to create initialized S3Client
 */
async function getMinioClientInstance() {
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

  return {
    s3Client,
    bucket: targetBucket,
    endpoint: minioEndpoint,
    region
  };
}

/**
 * Fetch available artifact versions from MinIO bucket deploybox
 */
async function getInstallationVersions({ app_name = 'mobile-api', env = 'dev' }) {
  try {
    const { s3Client, bucket, endpoint } = await getMinioClientInstance();

    const candidateAppNames = app_name === 'mobile-consume'
      ? ['mobile-consume', 'mobile-consumer']
      : [app_name];

    let foundVersions = [];

    for (const app of candidateAppNames) {
      let prefix = `${app}/${env}/`;
      if (app === 'big-screen') {
        prefix = `Screen-Apps/big-screen-app/${env}/`;
      } else if (app === 'small-screen') {
        prefix = `Screen-Apps/small-screen-app/${env}/`;
      }

      const command = new ListObjectsV2Command({
        Bucket: bucket,
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
        endpoint,
        bucket,
        versions: foundVersions
      };
    }

    return {
      success: true,
      app_name,
      env,
      endpoint,
      bucket,
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
 * Fetch detailed version list including files inside, file sizes, and timestamps
 */
async function getDetailedArtifactVersions({ app_name = 'mobile-api', env = 'dev' }) {
  try {
    const { s3Client, bucket, endpoint } = await getMinioClientInstance();

    const candidateAppNames = app_name === 'mobile-consume'
      ? ['mobile-consume', 'mobile-consumer']
      : [app_name];

    let versionDetailList = [];

    for (const app of candidateAppNames) {
      let prefix = `${app}/${env}/`;
      if (app === 'big-screen') {
        prefix = `Screen-Apps/big-screen-app/${env}/`;
      } else if (app === 'small-screen') {
        prefix = `Screen-Apps/small-screen-app/${env}/`;
      }

      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/'
      });

      const res = await s3Client.send(command);
      const prefixes = res.CommonPrefixes || [];

      for (const p of prefixes) {
        const parts = p.Prefix.split('/').filter(Boolean);
        const versionName = parts[parts.length - 1];
        if (!versionName) continue;

        // List all objects inside this specific version prefix
        const objCommand = new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: p.Prefix
        });

        const objRes = await s3Client.send(objCommand);
        const contents = objRes.Contents || [];

        let totalSizeBytes = 0;
        let latestDate = null;
        const files = contents.map(obj => {
          totalSizeBytes += obj.Size || 0;
          if (!latestDate || (obj.LastModified && obj.LastModified > latestDate)) {
            latestDate = obj.LastModified;
          }
          const filename = obj.Key.replace(p.Prefix, '');
          return {
            key: obj.Key,
            filename: filename || obj.Key.split('/').pop(),
            size: obj.Size || 0,
            lastModified: obj.LastModified
          };
        }).filter(f => f.filename && !f.filename.endsWith('/'));

        versionDetailList.push({
          version: versionName,
          app_name: app,
          env,
          prefix: p.Prefix,
          fileCount: files.length,
          totalSizeBytes,
          lastModified: latestDate,
          files
        });
      }
    }

    // Sort versions newest first
    versionDetailList = sortVersionsByNewest(versionDetailList);

    const grandTotalBytes = versionDetailList.reduce((acc, v) => acc + v.totalSizeBytes, 0);

    return {
      success: true,
      app_name,
      env,
      endpoint,
      bucket,
      totalVersions: versionDetailList.length,
      grandTotalBytes,
      versions: versionDetailList
    };
  } catch (err) {
    console.error('Error in getDetailedArtifactVersions:', err);
    return {
      success: false,
      app_name,
      env,
      error: `Gagal memuat rincian artefak MinIO (${err.message})`,
      versions: []
    };
  }
}

/**
 * Delete a single artifact version from MinIO
 */
async function deleteArtifactVersion({ app_name, env, version }) {
  try {
    if (!app_name || !env || !version) {
      throw new Error('app_name, env, dan version wajib ditentukan');
    }

    const { s3Client, bucket } = await getMinioClientInstance();

    const candidateAppNames = app_name === 'mobile-consume'
      ? ['mobile-consume', 'mobile-consumer']
      : [app_name];

    let totalDeleted = 0;

    for (const app of candidateAppNames) {
      const minioAppPath = resolveMinioAppPath(app);
      const prefix = `${minioAppPath}/${env}/${version}/`;

      // 1. List all objects under the version prefix
      const listCommand = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix
      });

      const listRes = await s3Client.send(listCommand);
      const contents = listRes.Contents || [];

      if (contents.length > 0) {
        // 2. Delete objects concurrently using DeleteObjectCommand (avoids MissingContentMD5 error on MinIO)
        await Promise.all(
          contents.map(obj =>
            s3Client.send(
              new DeleteObjectCommand({
                Bucket: bucket,
                Key: obj.Key
              })
            )
          )
        );
        totalDeleted += contents.length;
      }
    }

    return {
      success: true,
      message: `Versi ${version} (${totalDeleted} file) berhasil dihapus dari MinIO bucket ${bucket}`,
      deletedCount: totalDeleted,
      version
    };
  } catch (err) {
    console.error('Error deleting artifact version from MinIO:', err);
    return {
      success: false,
      error: `Gagal menghapus versi dari MinIO: ${err.message}`
    };
  }
}

/**
 * Delete multiple artifact versions in batch
 */
async function deleteBatchArtifactVersions({ app_name, env, versions = [] }) {
  try {
    if (!app_name || !env || versions.length === 0) {
      throw new Error('app_name, env, dan daftar versions wajib ditentukan');
    }

    let totalDeletedFiles = 0;
    const deletedVersions = [];
    const errors = [];

    for (const ver of versions) {
      const res = await deleteArtifactVersion({ app_name, env, version: ver });
      if (res.success) {
        totalDeletedFiles += res.deletedCount || 0;
        deletedVersions.push(ver);
      } else {
        errors.push({ version: ver, error: res.error });
      }
    }

    return {
      success: errors.length === 0,
      totalDeletedVersions: deletedVersions.length,
      totalDeletedFiles,
      deletedVersions,
      errors
    };
  } catch (err) {
    return {
      success: false,
      error: `Gagal melakukan batch delete MinIO: ${err.message}`
    };
  }
}

/**
 * Clean up older artifact versions, keeping only the N newest versions
 */
async function cleanupOldArtifactVersions({ app_name, env, keepCount = 3 }) {
  try {
    const details = await getDetailedArtifactVersions({ app_name, env });
    if (!details.success) {
      throw new Error(details.error);
    }

    const allVersions = details.versions || [];
    const keepLimit = Number(keepCount) || 3;

    if (allVersions.length <= keepLimit) {
      return {
        success: true,
        message: `Jumlah versi saat ini (${allVersions.length}) sudah sama atau kurang dari target penyimpanan (${keepLimit}). Tidak ada yang dihapus.`,
        deletedCount: 0,
        keptVersions: allVersions.map(v => v.version)
      };
    }

    // Versions beyond keepLimit are candidates for deletion
    const versionsToDelete = allVersions.slice(keepLimit).map(v => v.version);

    const batchRes = await deleteBatchArtifactVersions({
      app_name,
      env,
      versions: versionsToDelete
    });

    return {
      success: batchRes.success,
      message: `Pembersihan berhasil: ${batchRes.totalDeletedVersions} versi lama dihapus, ${keepLimit} versi terbaru dipertahankan.`,
      deletedVersions: versionsToDelete,
      keptVersions: allVersions.slice(0, keepLimit).map(v => v.version),
      totalDeletedFiles: batchRes.totalDeletedFiles
    };
  } catch (err) {
    return {
      success: false,
      error: `Gagal menjalankan cleanup versi lama: ${err.message}`
    };
  }
}

module.exports = {
  DEFAULT_MINIO_CONFIG,
  sortVersionsByNewest,
  resolveMinioAppPath,
  getMinioClientInstance,
  getInstallationVersions,
  getDetailedArtifactVersions,
  deleteArtifactVersion,
  deleteBatchArtifactVersions,
  cleanupOldArtifactVersions
};
