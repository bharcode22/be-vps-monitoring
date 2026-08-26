const masterToPodSyncService = require('./masterToPodSyncService');
const { dbAsync } = require('./db');

// Tables ordered to satisfy Foreign Key constraints
const TOP_DOWN_TABLES = [
  'terms_and_conditions_version',
  'terms_and_conditions_questions',
  'terms_and_conditions_question_bundle',
  'terms_and_conditions_question_history',
  'terms_and_conditions_version_question',
  'terms_and_conditions',
  'matrix_user',
  'matrix_user_history'
];

const BOTTOM_UP_TABLES = [
  'user',
  'terms_and_conditions_accepted',
  'terms_and_conditions_accepted_history',
  'terms_and_conditions_answers',
  'terms_and_conditions_answers_history'
];

/**
 * Publishes T&C Definitions from Master down to all (or specific) PODs.
 */
async function publishDefinitions(masterId, targetPodIds) {
  let allPods = Array.isArray(targetPodIds) && targetPodIds.length > 0 ? targetPodIds : [];
  
  if (allPods.length === 0) {
    const podsData = await dbAsync.all("SELECT id FROM servers WHERE pod_version = 'v3' ORDER BY name ASC");
    allPods = podsData.map(p => p.id);
  }

  const results = [];

  for (const tableName of TOP_DOWN_TABLES) {
    try {
      const syncResult = await masterToPodSyncService.syncMasterTableToPods({
        masterId: Number(masterId),
        tableName,
        targetPodIds: allPods,
        dryRun: false,
        syncColumns: true,
        syncData: true
      });
      results.push({ tableName, success: true, ...syncResult });
    } catch (err) {
      results.push({ tableName, success: false, error: err.message });
      // Stop to prevent broken foreign key cascades
      break;
    }
  }

  return { pipeline: 'publish', results };
}

/**
 * Pulls user and consent data from all PODs up to Master, 
 * and then distributes the consolidated data back to all PODs.
 */
async function pullConsentsAndDistribute(masterId, sourcePodIds) {
  let allPods = Array.isArray(sourcePodIds) && sourcePodIds.length > 0 ? sourcePodIds : [];
  
  if (allPods.length === 0) {
    const podsData = await dbAsync.all("SELECT id FROM servers WHERE pod_version = 'v3' ORDER BY name ASC");
    allPods = podsData.map(p => p.id);
  }

  const results = [];

  // Phase 1: PULL (POD -> Master)
  for (const tableName of BOTTOM_UP_TABLES) {
    for (const podId of allPods) {
      try {
        const pullResult = await masterToPodSyncService.syncPodTableToMaster({
          masterId: Number(masterId),
          serverId: podId,
          tableName,
          dryRun: false
        });
        results.push({ tableName, serverId: podId, stage: 'PULL', success: true, ...pullResult });
      } catch (err) {
        results.push({ tableName, serverId: podId, stage: 'PULL', success: false, error: err.message });
      }
    }
  }

  const hasPullErrors = results.some(r => r.stage === 'PULL' && !r.success);

  // Phase 2: DISTRIBUTE (Master -> POD)
  if (!hasPullErrors && allPods.length > 0) {
    for (const tableName of BOTTOM_UP_TABLES) {
      try {
        const distributeResult = await masterToPodSyncService.syncMasterTableToPods({
          masterId: Number(masterId),
          tableName,
          targetPodIds: allPods,
          dryRun: false,
          syncColumns: true,
          syncData: true
        });
        results.push({ tableName, stage: 'DISTRIBUTE', success: true, ...distributeResult });
      } catch (err) {
        results.push({ tableName, stage: 'DISTRIBUTE', success: false, error: err.message });
        break;
      }
    }
  }

  return { pipeline: 'pull-and-distribute', results };
}

module.exports = {
  publishDefinitions,
  pullConsentsAndDistribute
};
