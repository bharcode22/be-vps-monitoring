const { PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { getS3Client, getBucketName } = require('./s3Service');
const { getMasterPool } = require('./masterDbService');

/**
 * Generate AWS S3 Presigned PUT URLs for Direct Browser Upload
 * @param {string|number} soundScape 
 * @param {Array<{slotKey: string, filename: string, contentType: string}>} files 
 */
async function generateDirectS3PresignedUrls(soundScape, files = []) {
  if (!soundScape) throw new Error('Kode sound_scape wajib diisi.');
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('Daftar berkas untuk diunggah tidak boleh kosong.');
  }

  const cleanSoundScape = String(soundScape).trim().replace(/^\/+|\/+$/g, '');
  const s3Client = getS3Client();
  const bucket = getBucketName();
  const region = process.env.AWS_REGION || 'ap-southeast-1';

  const presignedList = [];

  for (const item of files) {
    const filename = String(item.filename || '').trim();
    if (!filename) continue;

    const s3Key = `media/${cleanSoundScape}/${filename}`;
    const contentType = item.contentType || 'application/octet-stream';

    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: contentType
    });

    // Generate Presigned URL valid for 15 minutes (900 seconds)
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 900 });
    const finalPublicUrl = `https://${bucket}.s3.${region}.amazonaws.com/${s3Key}`;
    const relativePath = `/media/${cleanSoundScape}/${filename}`;

    presignedList.push({
      slotKey: item.slotKey,
      filename,
      s3Key,
      uploadUrl,
      finalPublicUrl,
      relativePath,
      contentType
    });
  }

  return {
    soundScape: cleanSoundScape,
    bucket,
    region,
    files: presignedList
  };
}

/**
 * Save multimedia metadata to `multimedia` table & SHA-256 forensic hashes to `media_forensik` table
 * @param {Object} payload 
 */
async function saveDirectMultimediaWithForensics(payload) {
  const {
    sound_scape,
    title,
    artist,
    album,
    duration,
    files = []
  } = payload;

  if (!sound_scape) throw new Error('Kode sound_scape wajib diisi.');

  const pool = await getMasterPool();
  const cleanSoundScape = parseInt(sound_scape, 10) || sound_scape;

  // 1. Separate file data per slot
  let musicFile = null;
  let videoFile = null;
  let lampFile = null;
  let coverFile = null;

  files.forEach(f => {
    const slot = f.slotKey || f.type;
    if (slot === 'audio' || slot === 'music') musicFile = f;
    else if (slot === 'video') videoFile = f;
    else if (slot === 'lamp' || slot === 'strobe') lampFile = f;
    else if (slot === 'image' || slot === 'cover' || slot === 'coverAlbum') coverFile = f;
  });

  // 2. Insert or Update `multimedia` table in AWS Master Prod
  const checkExisting = await pool.query(
    'SELECT id FROM multimedia WHERE sound_scape = $1 LIMIT 1',
    [cleanSoundScape]
  );

  let multimediaRecord = null;
  const isShowVal = payload.isShowAtCustom === 'hide' ? 'hide' : 'show';

  if (checkExisting.rows.length > 0) {
    const existingId = checkExisting.rows[0].id;
    const updateQuery = `
      UPDATE multimedia SET
        tittle = COALESCE($1, tittle),
        artist = COALESCE($2, artist),
        album = COALESCE($3, album),
        duration = COALESCE($4, duration),
        music = COALESCE($5, music),
        "musicUrl" = COALESCE($6, "musicUrl"),
        "musicHash" = COALESCE($7, "musicHash"),
        video = COALESCE($8, video),
        "videoUrl" = COALESCE($9, "videoUrl"),
        "videoHash" = COALESCE($10, "videoHash"),
        lamp = COALESCE($11, lamp),
        "lampHash" = COALESCE($12, "lampHash"),
        cover_album = COALESCE($13, cover_album),
        "coverAlbumUrl" = COALESCE($14, "coverAlbumUrl"),
        "coverAlbumHash" = COALESCE($15, "coverAlbumHash"),
        "isShowAtCustom" = COALESCE($16, "isShowAtCustom"),
        update_date = NOW(),
        deleted_at = NULL
      WHERE id = $17
      RETURNING *;
    `;
    const res = await pool.query(updateQuery, [
      title || null,
      artist || null,
      album || null,
      duration ? String(duration) : null,
      musicFile?.name || musicFile?.filename || null,
      musicFile?.path || musicFile?.s3Url || null,
      musicFile?.sha256 || null,
      videoFile?.name || videoFile?.filename || null,
      videoFile?.path || videoFile?.s3Url || null,
      videoFile?.sha256 || null,
      lampFile?.name || lampFile?.filename || null,
      lampFile?.sha256 || null,
      coverFile?.name || coverFile?.filename || null,
      coverFile?.path || coverFile?.s3Url || null,
      coverFile?.sha256 || null,
      isShowVal,
      existingId
    ]);
    multimediaRecord = res.rows[0];
  } else {
    const insertQuery = `
      INSERT INTO multimedia (
        id, sound_scape, tittle, artist, album, duration,
        music, "musicUrl", "musicHash",
        video, "videoUrl", "videoHash",
        lamp, "lampHash",
        cover_album, "coverAlbumUrl", "coverAlbumHash",
        "isShowAtCustom",
        created_date, update_date
      )
      VALUES (
        gen_random_uuid(), $1, $2, $3, $4, $5,
        $6, $7, $8,
        $9, $10, $11,
        $12, $13,
        $14, $15, $16,
        $17,
        NOW(), NOW()
      )
      RETURNING *;
    `;
    const res = await pool.query(insertQuery, [
      cleanSoundScape,
      title || '',
      artist || '',
      album || '',
      duration ? String(duration) : '',
      musicFile?.name || musicFile?.filename || '',
      musicFile?.path || musicFile?.s3Url || '',
      musicFile?.sha256 || '',
      videoFile?.name || videoFile?.filename || '',
      videoFile?.path || videoFile?.s3Url || '',
      videoFile?.sha256 || '',
      lampFile?.name || lampFile?.filename || '',
      lampFile?.sha256 || '',
      coverFile?.name || coverFile?.filename || '',
      coverFile?.path || coverFile?.s3Url || '',
      coverFile?.sha256 || '',
      isShowVal
    ]);
    multimediaRecord = res.rows[0];
  }

  // 3. Insert or Update into `media_forensik` table for each uploaded file
  const forensicResults = [];

  for (const f of files) {
    const filename = f.name || f.filename;
    const sha256 = f.sha256;
    const path = f.path || f.s3Path || `media/${cleanSoundScape}/${filename}`;

    if (!filename || !sha256) continue;

    const checkForensic = await pool.query(
      'SELECT id FROM media_forensik WHERE name = $1 AND path = $2 LIMIT 1',
      [filename, path]
    );

    if (checkForensic.rows.length > 0) {
      const fId = checkForensic.rows[0].id;
      const updateF = await pool.query(
        'UPDATE media_forensik SET sha256 = $1, updated_at = NOW(), deleted_at = NULL WHERE id = $2 RETURNING *',
        [sha256, fId]
      );
      forensicResults.push(updateF.rows[0]);
    } else {
      const insertF = await pool.query(
        'INSERT INTO media_forensik (id, name, path, sha256, created_at, updated_at) VALUES (gen_random_uuid(), $1, $2, $3, NOW(), NOW()) RETURNING *',
        [filename, path, sha256]
      );
      forensicResults.push(insertF.rows[0]);
    }
  }

  return {
    success: true,
    sound_scape: cleanSoundScape,
    multimedia: multimediaRecord,
    forensics: forensicResults,
    message: `Data kode #${cleanSoundScape} berhasil disimpan ke tabel multimedia dan media_forensik`
  };
}

module.exports = {
  generateDirectS3PresignedUrls,
  saveDirectMultimediaWithForensics
};
