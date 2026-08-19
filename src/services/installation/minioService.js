const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
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
      let prefix = `${app}/${env}/`;
      if (app === 'big-screen') {
        prefix = `Screen-Apps/big-screen-app/${env}/`;
      } else if (app === 'small-screen') {
        prefix = `Screen-Apps/small-screen-app/${env}/`;
      }

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

module.exports = {
  DEFAULT_MINIO_CONFIG,
  sortVersionsByNewest,
  resolveMinioAppPath,
  getInstallationVersions
};
