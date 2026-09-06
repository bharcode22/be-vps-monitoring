const path = require('path');
const { queryPodDb } = require('./podDbClient');

/**
 * Audit Session Explore (self_development & self_development_sound)
 */
async function auditSessionExplore(masterPool, podServer, resolvedPodId, physicalFiles) {
  let masterExplores = [];
  let masterSounds = [];
  let podExplores = [];
  let podSounds = [];

  // Query Master
  try {
    let qExp = 'SELECT * FROM self_development ORDER BY id ASC';
    let pExp = [];
    if (resolvedPodId) {
      qExp = 'SELECT * FROM self_development WHERE fk_pod_id::text = $1::text ORDER BY id ASC';
      pExp = [String(resolvedPodId)];
    }
    const resExp = await masterPool.query(qExp, pExp);
    masterExplores = resExp.rows || [];

    const expIds = masterExplores.map(e => String(e.id)).filter(Boolean);
    if (expIds.length > 0) {
      const resDet = await masterPool.query('SELECT * FROM self_development_sound WHERE self_development_id::text = ANY($1::text[]) ORDER BY id ASC', [expIds]);
      masterSounds = resDet.rows || [];
    }
  } catch (err) {
    console.warn('[Report Collector] Master self_development query warning:', err.message);
  }

  // Query POD DB
  try {
    let qExp = 'SELECT * FROM self_development ORDER BY id ASC';
    let pExp = [];
    if (resolvedPodId) {
      qExp = 'SELECT * FROM self_development WHERE fk_pod_id::text = $1::text ORDER BY id ASC';
      pExp = [String(resolvedPodId)];
    }
    podExplores = await queryPodDb(podServer, qExp, pExp);
    if (podExplores.length === 0) {
      podExplores = await queryPodDb(podServer, 'SELECT * FROM self_development ORDER BY id ASC');
    }

    const expIds = podExplores.map(e => String(e.id)).filter(Boolean);
    if (expIds.length > 0) {
      podSounds = await queryPodDb(podServer, 'SELECT * FROM self_development_sound WHERE self_development_id::text = ANY($1::text[]) ORDER BY id ASC', [expIds]);
    }
    // Fallback: If podSounds is empty, query all self_development_sound
    if (!podSounds || podSounds.length === 0) {
      podSounds = await queryPodDb(podServer, 'SELECT * FROM self_development_sound ORDER BY id ASC');
    }
  } catch (err) {
    console.warn('[Report Collector] POD self_development query warning:', err.message);
  }

  // Build category map: self_development_id -> self_development info
  const devMap = new Map();
  const allDevList = podExplores.length > 0 ? podExplores : masterExplores;
  allDevList.forEach(e => {
    devMap.set(String(e.id), {
      id: e.id,
      name: e.self_development_name || e.name || 'Explore',
      description: e.description || ''
    });
  });

  // File verification on POD details
  // self_development_sound columns: lamp, song/sound, video, cover_album, sound_code, sound_scape
  const soundsMap = physicalFiles.soundsMap;
  const videosMap = physicalFiles.videosMap;
  const imagesMap = physicalFiles.imagesMap;

  let totalFilesChecked = 0;
  let totalFilesReady = 0;
  let totalFilesMissing = 0;

  const verifiedSounds = (podSounds.length > 0 ? podSounds : masterSounds).map(item => {
    const rawSound = item.song || item.sound || null;
    const soundName = rawSound ? path.basename(rawSound).trim() : null;
    const lampName = item.lamp ? path.basename(item.lamp).trim() : null;
    const videoName = item.video ? path.basename(item.video).trim() : null;
    const coverName = item.cover_album ? path.basename(item.cover_album).trim() : null;

    const checkFile = (fname, mediaMap, targetDir) => {
      if (!fname || fname === '0' || fname === 'null' || String(fname).trim() === '') {
        return { name: null, exists: true, status: 'NOT_APPLICABLE' };
      }
      const cleanFname = String(fname).trim();
      totalFilesChecked++;
      const exists = mediaMap.has(cleanFname.toLowerCase());
      if (exists) {
        totalFilesReady++;
        const fileInfo = mediaMap.get(cleanFname.toLowerCase());
        return { name: cleanFname, exists: true, status: 'READY', fullPath: fileInfo.fullPath, sizeBytes: fileInfo.sizeBytes };
      } else {
        totalFilesMissing++;
        return { name: cleanFname, exists: false, status: 'MISSING', expectedPath: `${targetDir}/${cleanFname}` };
      }
    };

    const soundCheck = checkFile(soundName, soundsMap, '/home/pod/sounds');
    const lampCheck = checkFile(lampName, soundsMap, '/home/pod/sounds');
    const videoCheck = checkFile(videoName, videosMap, '/home/pod/videos');
    const coverCheck = checkFile(coverName, imagesMap, '/home/pod/images');
    const parentDev = devMap.get(String(item.self_development_id)) || { name: 'Explore', description: '' };

    const rawCode = item.sound_code != null ? String(item.sound_code).trim() : null;
    const rawScape = item.sound_scape != null ? String(item.sound_scape).trim() : rawCode;

    return {
      id: item.id,
      selfDevelopmentId: item.self_development_id,
      category: parentDev.name,
      categoryDescription: parentDev.description,
      name: item.title || item.self_development_name || item.name || `Sound #${String(item.id).slice(0, 8)}`,
      soundCode: rawCode,
      soundScape: rawScape,
      sound: soundCheck,
      lamp: lampCheck,
      video: videoCheck,
      coverAlbum: coverCheck,
      allFilesReady: soundCheck.exists && lampCheck.exists && videoCheck.exists && coverCheck.exists
    };
  });

  // Group by Parent Self Development Category
  const expCategoriesMap = new Map();
  allDevList.forEach(e => {
    const catName = e.self_development_name || e.name || 'Explore';
    expCategoriesMap.set(catName, {
      id: e.id,
      name: catName,
      description: e.description || '',
      items: []
    });
  });

  verifiedSounds.forEach(item => {
    if (!expCategoriesMap.has(item.category)) {
      expCategoriesMap.set(item.category, {
        id: item.selfDevelopmentId,
        name: item.category,
        description: item.categoryDescription || '',
        items: []
      });
    }
    expCategoriesMap.get(item.category).items.push(item);
  });

  const expCategories = Array.from(expCategoriesMap.values()).filter(c => c.items.length > 0);

  return {
    podId: resolvedPodId,
    masterExploreCount: masterExplores.length,
    podExploreCount: podExplores.length,
    masterSoundCount: masterSounds.length,
    podSoundCount: podSounds.length,
    rowSyncMatched: masterExplores.length === podExplores.length && masterSounds.length === podSounds.length,
    totalFilesChecked,
    totalFilesReady,
    totalFilesMissing,
    fileAvailabilityPct: totalFilesChecked > 0 ? Math.round((totalFilesReady / totalFilesChecked) * 100) : 100,
    items: verifiedSounds,
    categories: expCategories
  };
}

module.exports = {
  auditSessionExplore
};
