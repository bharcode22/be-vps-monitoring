const path = require('path');
const { queryPodDb } = require('./podDbClient');

/**
 * Audit Session Signature (experiences / experience & detail_experience)
 */
async function auditSessionSignature(masterPool, podServer, resolvedPodId, physicalFiles) {
  let masterExperiences = [];
  let masterDetails = [];
  let podExperiences = [];
  let podDetails = [];

  // Helper query experience table (supports both 'experiences' and 'experience')
  const queryExpTable = async (queryFn, whereClause = '', params = []) => {
    try {
      const rows = await queryFn(`SELECT * FROM experiences ${whereClause} ORDER BY created_date DESC, id ASC`, params);
      if (rows && rows.length > 0) return rows;
    } catch (_) { }
    try {
      const rows = await queryFn(`SELECT * FROM experience ${whereClause} ORDER BY id ASC`, params);
      return rows || [];
    } catch (_) { }
    return [];
  };

  // Query Master
  try {
    const where = resolvedPodId ? 'WHERE pod_id::text = $1::text' : '';
    const params = resolvedPodId ? [String(resolvedPodId)] : [];
    masterExperiences = await queryExpTable(async (q, p) => (await masterPool.query(q, p)).rows, where, params);

    const expIds = masterExperiences.map(e => String(e.id)).filter(Boolean);
    if (expIds.length > 0) {
      try {
        const resDet = await masterPool.query('SELECT * FROM detail_experience WHERE experience_id::text = ANY($1::text[]) ORDER BY id ASC', [expIds]);
        masterDetails = resDet.rows || [];
      } catch (eDet) {
        console.warn('[Report Collector] Master detail_experience warning:', eDet.message);
      }
    }
  } catch (err) {
    console.warn('[Report Collector] Master experience query warning:', err.message);
  }

  // Query POD DB
  try {
    const where = resolvedPodId ? 'WHERE pod_id::text = $1::text' : '';
    const params = resolvedPodId ? [String(resolvedPodId)] : [];
    podExperiences = await queryExpTable(async (q, p) => await queryPodDb(podServer, q, p), where, params);
    if (podExperiences.length === 0) {
      podExperiences = await queryExpTable(async (q) => await queryPodDb(podServer, q));
    }

    const expIds = podExperiences.map(e => String(e.id)).filter(Boolean);
    if (expIds.length > 0) {
      podDetails = await queryPodDb(
        podServer,
        'SELECT * FROM detail_experience WHERE experience_id::text = ANY($1::text[]) ORDER BY id ASC',
        [expIds]
      );
    }
    // Fallback: If podDetails is still empty, query all detail_experience unconditionally
    if (!podDetails || podDetails.length === 0) {
      podDetails = await queryPodDb(podServer, 'SELECT * FROM detail_experience ORDER BY id ASC');
    }
  } catch (err) {
    console.warn('[Report Collector] POD experience query warning:', err.message);
  }

  // Build category map: experience_id -> parent experience info
  const expMap = new Map();
  const allExpList = podExperiences.length > 0 ? podExperiences : masterExperiences;
  allExpList.forEach(e => {
    expMap.set(String(e.id), {
      id: e.id,
      name: e.menu_name || e.name || 'Signature',
      information: e.information || e.description || '',
      linkClass: e.link_class || ''
    });
  });

  // File verification on POD details
  // detail_experience columns: video, song, lamp, sound_scape
  const soundsMap = physicalFiles.soundsMap;
  const videosMap = physicalFiles.videosMap;

  let totalFilesChecked = 0;
  let totalFilesReady = 0;
  let totalFilesMissing = 0;

  const verifiedDetails = (podDetails.length > 0 ? podDetails : masterDetails).map(item => {
    const songName = item.song ? path.basename(item.song).trim() : null;
    const lampName = item.lamp ? path.basename(item.lamp).trim() : null;
    const videoName = item.video ? path.basename(item.video).trim() : null;

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

    const songCheck = checkFile(songName, soundsMap, '/home/pod/sounds');
    const lampCheck = checkFile(lampName, soundsMap, '/home/pod/sounds');
    const videoCheck = checkFile(videoName, videosMap, '/home/pod/videos');
    const parentExp = expMap.get(String(item.experience_id)) || { name: 'Signature', information: '' };

    const rawScape = item.sound_scape != null ? String(item.sound_scape).trim() : null;
    const rawCode = item.sound_code != null ? String(item.sound_code).trim() : rawScape;

    return {
      id: item.id,
      experienceId: item.experience_id,
      category: parentExp.name,
      categoryInfo: parentExp.information,
      name: item.title || item.menu_name || item.name || `Detail #${String(item.id).slice(0, 8)}`,
      soundScape: rawScape,
      soundCode: rawCode,
      song: songCheck,
      lamp: lampCheck,
      video: videoCheck,
      allFilesReady: songCheck.exists && lampCheck.exists && videoCheck.exists
    };
  });

  // Group by Parent Experience Category
  const sigCategoriesMap = new Map();
  allExpList.forEach(e => {
    const catName = e.menu_name || e.name || 'Signature';
    sigCategoriesMap.set(catName, {
      id: e.id,
      name: catName,
      information: e.information || e.description || '',
      items: []
    });
  });

  verifiedDetails.forEach(item => {
    if (!sigCategoriesMap.has(item.category)) {
      sigCategoriesMap.set(item.category, {
        id: item.experienceId,
        name: item.category,
        information: item.categoryInfo || '',
        items: []
      });
    }
    sigCategoriesMap.get(item.category).items.push(item);
  });

  const sigCategories = Array.from(sigCategoriesMap.values()).filter(c => c.items.length > 0);

  return {
    podId: resolvedPodId,
    masterExperienceCount: masterExperiences.length,
    podExperienceCount: podExperiences.length,
    masterDetailCount: masterDetails.length,
    podDetailCount: podDetails.length,
    rowSyncMatched: masterExperiences.length === podExperiences.length && masterDetails.length === podDetails.length,
    totalFilesChecked,
    totalFilesReady,
    totalFilesMissing,
    fileAvailabilityPct: totalFilesChecked > 0 ? Math.round((totalFilesReady / totalFilesChecked) * 100) : 100,
    items: verifiedDetails,
    categories: sigCategories
  };
}

module.exports = {
  auditSessionSignature
};
