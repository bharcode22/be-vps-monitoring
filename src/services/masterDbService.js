const { Pool } = require('pg');
const { decrypt } = require('../utils/crypto');
const dbAsync = require('./db');

let masterPool = null;

async function getMasterPool() {
  if (masterPool) return masterPool;

  try {
    const dbInfo = await dbAsync.get("SELECT * FROM databases_postgres WHERE name = 'AWS Master Prod' LIMIT 1");
    if (!dbInfo) {
      throw new Error('Database AWS Master Prod tidak ditemukan di tabel databases_postgres');
    }

    const password = decrypt(dbInfo.password);

    masterPool = new Pool({
      host: dbInfo.host,
      port: dbInfo.port,
      database: dbInfo.db_name,
      user: dbInfo.db_user,
      password: password,
      ssl: { rejectUnauthorized: false },
      max: 5,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 15000
    });

    masterPool.on('error', (err) => {
      console.error('❌ Unexpected error on AWS Master Prod pool:', err.message);
    });

    return masterPool;
  } catch (error) {
    console.error('Gagal membuat koneksi ke AWS Master Prod:', error.message);
    throw error;
  }
}

async function getMultimediaSoundScapes() {
  const pool = await getMasterPool();
  const result = await pool.query('SELECT sound_scape FROM multimedia WHERE sound_scape IS NOT NULL');
  return result.rows.map(row => row.sound_scape.toString().trim());
}

async function getValidMultimediaFilenames() {
  const pool = await getMasterPool();
  // Get all URLs from multimedia
  const result = await pool.query('SELECT "musicUrl", "videoUrl", "coverAlbumUrl", lamp FROM multimedia');

  // Get filenames from fileFlowEditor
  const fileFlowResult = await pool.query('SELECT file_name FROM "fileFlowEditor" WHERE file_name IS NOT NULL');

  const filenames = new Set();

  const extractName = (urlOrPath) => {
    if (!urlOrPath || typeof urlOrPath !== 'string') return null;
    try {
      // Handle full URLs or just paths
      const parts = urlOrPath.split('/');
      let name = parts[parts.length - 1];
      if (name.includes('?')) {
        name = name.split('?')[0]; // Remove query params
      }
      return name.toLowerCase().trim();
    } catch (e) {
      return null;
    }
  };

  result.rows.forEach(row => {
    const audio = extractName(row.musicUrl);
    const video = extractName(row.videoUrl);
    const cover = extractName(row.coverAlbumUrl);
    const strobe = extractName(row.lamp);

    if (audio) filenames.add(audio);
    if (video) filenames.add(video);
    if (cover) filenames.add(cover);
    if (strobe) filenames.add(strobe);
  });

  // Add fileFlowEditor filenames directly (they seem to be just filenames, but we extract just in case)
  fileFlowResult.rows.forEach(row => {
    const flowFileName = extractName(row.file_name);
    if (flowFileName) filenames.add(flowFileName);
  });

  return Array.from(filenames);
}

async function getFileFlowEditorRecords() {
  const pool = await getMasterPool();
  const query = `
    SELECT 
      id, 
      file_name, 
      file_type, 
      placement, 
      url, 
      created_date, 
      update_date, 
      deleted_at 
    FROM "fileFlowEditor" 
    WHERE deleted_at IS NULL 
    ORDER BY created_date DESC;
  `;
  const result = await pool.query(query);
  return result.rows;
}

async function getMultimediaDetailBySoundScape(soundScapeId) {
  try {
    const pool = await getMasterPool();
    const result = await pool.query(
      'SELECT * FROM multimedia WHERE sound_scape::text = $1 OR id::text = $1 LIMIT 1',
      [String(soundScapeId).trim()]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Error fetching multimedia by sound_scape:', err.message);
    return null;
  }
}

async function getAllMultimediaList() {
  try {
    const pool = await getMasterPool();
    const result = await pool.query(
      'SELECT sound_scape, song as title, name, lamp FROM multimedia WHERE sound_scape IS NOT NULL ORDER BY sound_scape ASC LIMIT 200'
    );
    return result.rows || [];
  } catch (err) {
    console.error('Error fetching multimedia list:', err.message);
    return [];
  }
}

module.exports = {
  getMultimediaSoundScapes,
  getValidMultimediaFilenames,
  getFileFlowEditorRecords,
  getMultimediaDetailBySoundScape,
  getAllMultimediaList
};
