const { S3Client, ListObjectsV2Command, HeadObjectCommand, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const path = require('path');

function getS3Client() {
  const region = process.env.AWS_REGION || 'ap-southeast-1';
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error('AWS S3 credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) belum dikonfigurasi di .env');
  }

  return new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey
    }
  });
}

function getBucketName() {
  return process.env.AWS_S3_BUCKET || 'developerfile-084897310273';
}

function getBasePath() {
  let basePath = process.env.AWS_S3_PATH || 'media';
  // Strip leading and trailing slashes
  basePath = basePath.replace(/^\/+|\/+$/g, '');
  return basePath ? `${basePath}/` : '';
}

/**
 * Determine media category from filename extension
 */
function categorizeFile(filename) {
  const ext = path.extname(filename || '').toLowerCase();
  const nameLower = (filename || '').toLowerCase();

  if (['.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma'].includes(ext)) {
    return 'audio';
  }
  if (['.mp4', '.webm', '.mkv', '.mov', '.avi', '.flv', '.wmv'].includes(ext)) {
    return 'video';
  }
  if (['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif', '.bmp', '.ico'].includes(ext)) {
    return 'image';
  }
  if (nameLower.includes('strobe') || ['.strobe', '.patt'].includes(ext) || (ext === '.json' && nameLower.includes('light'))) {
    return 'strobe';
  }
  if (ext === '.json') {
    return 'metadata';
  }
  return 'other';
}

/**
 * Format bytes to readable human string
 */
function formatBytes(bytes, decimals = 2) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

/**
 * List all code folders inside S3 prefix (e.g. media/144411/, media/144412/)
 */
async function listS3MediaFolders() {
  const client = getS3Client();
  const bucket = getBucketName();
  const prefix = getBasePath();

  const command = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    Delimiter: '/'
  });

  const response = await client.send(command);
  const commonPrefixes = response.CommonPrefixes || [];

  const folders = [];

  for (const p of commonPrefixes) {
    const rawPrefix = p.Prefix || '';
    // Extract code folder name, e.g. media/144411/ -> 144411
    const subPath = rawPrefix.replace(prefix, '').replace(/\/$/, '');
    if (!subPath) continue;

    // Fetch brief stats for this folder
    const listSubCmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: rawPrefix,
      MaxKeys: 1000
    });

    try {
      const subRes = await client.send(listSubCmd);
      const objects = subRes.Contents || [];

      let totalSize = 0;
      let audioCount = 0;
      let videoCount = 0;
      let imageCount = 0;
      let strobeCount = 0;
      let otherCount = 0;

      objects.forEach(obj => {
        totalSize += obj.Size || 0;
        const category = categorizeFile(obj.Key);
        if (category === 'audio') audioCount++;
        else if (category === 'video') videoCount++;
        else if (category === 'image') imageCount++;
        else if (category === 'strobe') strobeCount++;
        else otherCount++;
      });

      folders.push({
        code: subPath,
        prefix: rawPrefix,
        totalFiles: objects.length,
        totalSizeBytes: totalSize,
        totalSizeFormatted: formatBytes(totalSize),
        audioCount,
        videoCount,
        imageCount,
        strobeCount,
        otherCount,
        lastModified: objects.length > 0 ? objects[0].LastModified : null
      });
    } catch (err) {
      console.error(`Error inspecting folder ${rawPrefix}:`, err.message);
      folders.push({
        code: subPath,
        prefix: rawPrefix,
        totalFiles: 0,
        totalSizeBytes: 0,
        totalSizeFormatted: '0 B',
        audioCount: 0,
        videoCount: 0,
        imageCount: 0,
        strobeCount: 0,
        otherCount: 0,
        error: err.message
      });
    }
  }

  // Sort folders alphabetically or by code
  folders.sort((a, b) => b.totalSizeBytes - a.totalSizeBytes);

  return {
    bucket,
    basePrefix: prefix,
    totalFolders: folders.length,
    folders
  };
}

/**
 * List all files inside a specific code folder (e.g. media/144411/)
 */
async function listS3FolderFiles(code) {
  const client = getS3Client();
  const bucket = getBucketName();
  const basePrefix = getBasePath();
  const folderPrefix = code.startsWith(basePrefix) ? code : `${basePrefix}${code}/`;

  let continuationToken = undefined;
  let allObjects = [];

  do {
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: folderPrefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000
    });

    const response = await client.send(command);
    if (response.Contents) {
      allObjects = allObjects.concat(response.Contents);
    }
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  const baseUrl = process.env.AWS_URL || `https://${bucket}.s3.${process.env.AWS_REGION || 'ap-southeast-1'}.amazonaws.com`;

  const files = allObjects
    .filter(obj => !obj.Key.endsWith('/')) // exclude folder entries
    .map(obj => {
      const filename = path.basename(obj.Key);
      const relativePath = obj.Key.replace(folderPrefix, '');
      const category = categorizeFile(filename);

      return {
        key: obj.Key,
        filename,
        relativePath,
        category,
        sizeBytes: obj.Size || 0,
        sizeFormatted: formatBytes(obj.Size || 0),
        lastModified: obj.LastModified,
        url: `${baseUrl}/${encodeURI(obj.Key)}`
      };
    });

  const summary = {
    totalFiles: files.length,
    totalSizeBytes: files.reduce((acc, f) => acc + f.sizeBytes, 0),
    audio: files.filter(f => f.category === 'audio'),
    video: files.filter(f => f.category === 'video'),
    image: files.filter(f => f.category === 'image'),
    strobe: files.filter(f => f.category === 'strobe'),
    metadata: files.filter(f => f.category === 'metadata'),
    other: files.filter(f => f.category === 'other')
  };

  return {
    bucket,
    code,
    folderPrefix,
    totalFiles: summary.totalFiles,
    totalSizeBytes: summary.totalSizeBytes,
    totalSizeFormatted: formatBytes(summary.totalSizeBytes),
    counts: {
      audio: summary.audio.length,
      video: summary.video.length,
      image: summary.image.length,
      strobe: summary.strobe.length,
      metadata: summary.metadata.length,
      other: summary.other.length
    },
    files
  };
}

/**
 * Hard delete entire code folder from AWS S3 (media/<codeFolder>/)
 */
async function deleteS3CodeFolder(code) {
  const client = getS3Client();
  const bucket = getBucketName();
  const basePrefix = getBasePath();
  const folderPrefix = code.startsWith(basePrefix) ? code : `${basePrefix}${code}/`;

  let continuationToken = undefined;
  let allKeys = [];
  let totalBytes = 0;

  do {
    const listCmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: folderPrefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000
    });

    const listRes = await client.send(listCmd);
    if (listRes.Contents && listRes.Contents.length > 0) {
      listRes.Contents.forEach(obj => {
        allKeys.push({ Key: obj.Key });
        totalBytes += obj.Size || 0;
      });
    }
    continuationToken = listRes.NextContinuationToken;
  } while (continuationToken);

  if (allKeys.length === 0) {
    return {
      success: true,
      code,
      deletedCount: 0,
      freedBytes: 0,
      freedFormatted: '0 B',
      message: `Folder S3 ${folderPrefix} tidak memiliki file atau sudah terhapus.`
    };
  }

  // Delete objects in batches of up to 1000 keys
  const chunkSize = 1000;
  for (let i = 0; i < allKeys.length; i += chunkSize) {
    const chunk = allKeys.slice(i, i + chunkSize);
    const deleteCmd = new DeleteObjectsCommand({
      Bucket: bucket,
      Delete: {
        Objects: chunk,
        Quiet: false
      }
    });
    await client.send(deleteCmd);
  }

  return {
    success: true,
    code,
    deletedCount: allKeys.length,
    freedBytes: totalBytes,
    freedFormatted: formatBytes(totalBytes),
    message: `Berhasil menghapus folder S3 ${code} (${allKeys.length} file, ${formatBytes(totalBytes)})`
  };
}

/**
 * Recursively list all filenames in the S3 media bucket
 */
async function listAllS3Filenames() {
  const client = getS3Client();
  const bucket = getBucketName();
  const prefix = getBasePath();

  const filenames = new Set();
  let continuationToken = undefined;

  try {
    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      });
      const response = await client.send(command);
      
      if (response.Contents) {
        for (const item of response.Contents) {
          if (item.Key && !item.Key.endsWith('/')) {
            const basename = path.basename(item.Key).toLowerCase();
            filenames.add(basename);
          }
        }
      }
      
      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return Array.from(filenames);
  } catch (error) {
    console.error('Error fetching all S3 filenames:', error.message);
    throw error;
  }
}

module.exports = {
  getS3Client,
  getBucketName,
  getBasePath,
  categorizeFile,
  formatBytes,
  listS3MediaFolders,
  listS3FolderFiles,
  deleteS3CodeFolder,
  listAllS3Filenames
};
