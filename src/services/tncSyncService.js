const masterToPodSyncService = require('./masterToPodSyncService');
const { dbAsync } = require('./db');

// Tables ordered to satisfy Foreign Key constraints
const TOP_DOWN_TABLES = [
  'terms_and_conditions_version',
  'terms_and_conditions_questions',
  'terms_and_conditions_question_bundle',
  'terms_and_conditions_question_history',
  'terms_and_conditions_version_question',
  'terms_and_conditions'
];

const BOTTOM_UP_TABLES = [
  'user',
  'matrix_user',
  'matrix_user_history',
  'terms_and_conditions_accepted',
  'terms_and_conditions_accepted_history',
  'terms_and_conditions_answers',
  'terms_and_conditions_answers_history'
];

/**
 * Publishes T&C Definitions from Master down to all (or specific) PODs.
 */
async function publishDefinitions(masterId, targetPodIds) {
  let allPods = targetPodIds;
  
  if (!allPods || allPods.length === 0) {
    // If no target pods provided, default to ALL pods connected to this master
    const podsData = await dbAsync.all('SELECT id FROM databases_postgres WHERE master_id = ?', [masterId]);
    allPods = podsData.map(p => p.id);
  }

  const results = [];

  for (const tableName of TOP_DOWN_TABLES) {
    try {
      const syncResult = await masterToPodSyncService.syncMasterTableToPods(
        masterId,
        tableName,
        allPods,
        false // Dry run = false
      );
      results.push({ tableName, success: true, ...syncResult });
    } catch (err) {
      results.push({ tableName, success: false, error: err.message });
      // If a foundational table fails, we should probably stop the pipeline to avoid FK cascade errors
      break; 
    }
  }

  return { pipeline: 'publish', results };
}

/**
 * Pulls user and consent data from all PODs up to Master, 
 * and then optionally distributes the consolidated data back to all PODs.
 */
async function pullConsentsAndDistribute(masterId, sourcePodIds) {
  let allPods = sourcePodIds;
  
  if (!allPods || allPods.length === 0) {
    const podsData = await dbAsync.all('SELECT id FROM databases_postgres WHERE master_id = ?', [masterId]);
    allPods = podsData.map(p => p.id);
  }

  const results = [];

  // Phase 1: PULL (POD -> Master)
  for (const tableName of BOTTOM_UP_TABLES) {
    try {
      const pullResult = await masterToPodSyncService.syncPodTableToMaster(
        masterId,
        tableName,
        allPods,
        false // dryRun
      );
      results.push({ tableName, stage: 'PULL', success: true, ...pullResult });
    } catch (err) {
      results.push({ tableName, stage: 'PULL', success: false, error: err.message });
      break; // Stop if parent table fails
    }
  }

  const hasPullErrors = results.some(r => !r.success);

  // Phase 2: DISTRIBUTE (Master -> POD) 
  // Only if pull was entirely successful to avoid distributing incomplete data
  if (!hasPullErrors) {
    for (const tableName of BOTTOM_UP_TABLES) {
      try {
        const distributeResult = await masterToPodSyncService.syncMasterTableToPods(
          masterId,
          tableName,
          allPods,
          false // dryRun
        );
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
