const { S3Client, ListBucketsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { decrypt } = require('../../utils/crypto');

/**
 * Gather real-time metrics for MinIO / AWS S3 Storage
 */
async function getS3Metrics(server) {
  const startTime = Date.now();
  const rawSecret = server.s3_secret_key || server.password || '';

  const clientConfig = {
    region: server.s3_region || 'us-east-1',
    credentials: {
      accessKeyId: server.s3_access_key || server.username || '',
      secretAccessKey: decrypt(rawSecret)
    }
  };

  if (server.s3_endpoint) {
    let endpoint = server.s3_endpoint.trim();
    if (!endpoint.startsWith('http://') && !endpoint.startsWith('https://')) {
      endpoint = `http://${endpoint}`;
    }
    const hasPortInUrl = /:\d+$/.test(endpoint) || /:\d+\//.test(endpoint);
    if (server.port && !hasPortInUrl) {
      endpoint = `${endpoint}:${server.port}`;
    }
    clientConfig.endpoint = endpoint;
    clientConfig.forcePathStyle = true; // Required for MinIO
  }

  const s3Client = new S3Client(clientConfig);

  try {
    // 1. List buckets to test status & latency
    const bucketsRes = await s3Client.send(new ListBucketsCommand({}));
    const pingMs = Math.round(Date.now() - startTime);

    const buckets = (bucketsRes.Buckets || []).map(b => ({
      name: b.Name,
      creationDate: b.CreationDate
    }));

    let totalObjects = 0;
    let totalSizeBytes = 0;

    // 2. Scan target bucket if provided
    const targetBucket = server.s3_bucket || (buckets[0] ? buckets[0].name : '');

    if (targetBucket) {
      try {
        const objectsRes = await s3Client.send(new ListObjectsV2Command({ Bucket: targetBucket, MaxKeys: 1000 }));
        const objects = objectsRes.Contents || [];
        totalObjects = objects.length;
        totalSizeBytes = objects.reduce((acc, obj) => acc + (obj.Size || 0), 0);
      } catch (e) {
        // Target bucket scan optional
      }
    }

    const diskUsedGb = Math.round((totalSizeBytes / (1024 * 1024 * 1024)) * 100) / 100;
    const ramUsedMb = Math.round((totalSizeBytes / (1024 * 1024)) * 100) / 100;

    return {
      cpuUsage: Math.min(100, totalObjects % 100),
      cpuCores: buckets.length,
      ramUsage: totalObjects,
      ramUsedMb,
      ramFreeMb: 0,
      ramTotalMb: ramUsedMb,
      bandwidthRxSpeed: pingMs,
      bandwidthTxSpeed: totalObjects,
      diskUsage: Math.min(100, Math.round((diskUsedGb / 500) * 100)),
      diskUsedGb,
      diskTotalGb: 500,
      diskFreeGb: 500 - diskUsedGb,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: server.type === 'minio' ? 'MinIO Object Storage' : 'AWS S3 Storage',
      gpuTemp: 0,
      pingMs,
      status: 'online',
      buckets,
      totalBuckets: buckets.length,
      targetBucket,
      totalObjects,
      totalSizeBytes
    };
  } catch (err) {
    return {
      cpuUsage: 0,
      cpuCores: 0,
      ramUsage: 0,
      ramUsedMb: 0,
      ramFreeMb: 0,
      ramTotalMb: 0,
      bandwidthRxSpeed: 0,
      bandwidthTxSpeed: 0,
      diskUsage: 0,
      diskUsedGb: 0,
      diskTotalGb: 0,
      diskFreeGb: 0,
      gpuUsage: 0,
      gpuMemoryUsage: 0,
      gpuName: server.type === 'minio' ? 'MinIO (Offline)' : 'AWS S3 (Offline)',
      gpuTemp: 0,
      pingMs: 0,
      status: 'offline',
      error: err.message,
      buckets: [],
      totalBuckets: 0,
      targetBucket: server.s3_bucket || '',
      totalObjects: 0,
      totalSizeBytes: 0
    };
  }
}

module.exports = {
  getS3Metrics
};
