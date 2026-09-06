const { getMasterPool } = require('../../masterDbService');
const { getPodDbUrl, queryPodDb } = require('./podDbClient');
const { scanPodPhysicalFiles } = require('./physicalFileScanner');
const { getPodStorageBaseDir, resolvePodStorageDir, resolvePodId } = require('./podResolver');
const { compareTopicList, collectTopicsComparison } = require('./topicCollector');
const { collectHourlyHeartbeatTelemetry } = require('./heartbeatCollector');
const { auditSessionSignature } = require('./signatureCollector');
const { auditSessionExplore } = require('./exploreCollector');

/**
 * Main Orchestrator: Collect all diagnostic & audit report data for a POD V3
 * @param {Object} podServer - Server record from database
 * @returns {Promise<Object>} Consolidated report data
 */
async function collectFullPodReportData(podServer) {
  const startTime = Date.now();
  console.log(`📊 [Report Collector] Memulai pengumpulan data diagnostik untuk ${podServer.name}...`);

  // 1. Get Master DB Pool
  const masterPool = await getMasterPool();

  // 2. Resolve POD ID
  const resolvedPodId = await resolvePodId(masterPool, podServer);

  // 3. Run all independent gathering tasks in parallel
  const [topicsResult, heartbeatResult, physicalFilesResult] = await Promise.all([
    collectTopicsComparison(masterPool, podServer),
    collectHourlyHeartbeatTelemetry(podServer),
    scanPodPhysicalFiles(podServer)
  ]);

  // 4. Audit Sessions with physical files map in parallel
  const [signatureResult, exploreResult] = await Promise.all([
    auditSessionSignature(masterPool, podServer, resolvedPodId, physicalFilesResult),
    auditSessionExplore(masterPool, podServer, resolvedPodId, physicalFilesResult)
  ]);

  // 5. Calculate Consolidated Overall Health Score (0 - 100%)
  // Weights:
  // - Topics Synced: 20%
  // - Heartbeat 1-hr Uptime: 30%
  // - Signature Files Ready: 25%
  // - Explore Files Ready: 25%
  const topicsScore = topicsResult.overallSynced
    ? 100
    : (topicsResult.podTopics.matchedCount / (topicsResult.podTopics.totalMaster || 1)) * 100;
  const hbScore = heartbeatResult.averageUptimePct;
  const sigFileScore = signatureResult.fileAvailabilityPct;
  const expFileScore = exploreResult.fileAvailabilityPct;

  const overallHealthScore = Math.round(
    (topicsScore * 0.20) +
    (hbScore * 0.30) +
    (sigFileScore * 0.25) +
    (expFileScore * 0.25)
  );

  const durationMs = Date.now() - startTime;
  console.log(`✅ [Report Collector] Selesai mengumpulkan data untuk ${podServer.name} dalam ${durationMs}ms. Health Score: ${overallHealthScore}%`);

  return {
    metadata: {
      serverId: podServer.id,
      serverName: podServer.name,
      serverCode: podServer.code || `POD_${podServer.id}`,
      serverHost: podServer.host,
      podUuid: podServer.pod_uuid || null,
      resolvedPodId,
      generatedAt: new Date().toISOString(),
      durationMs
    },
    scores: {
      overallHealthScore,
      topicsScore: Math.round(topicsScore),
      heartbeatScore: Math.round(hbScore),
      signatureFileScore: Math.round(sigFileScore),
      exploreFileScore: Math.round(expFileScore)
    },
    topics: topicsResult,
    heartbeat: heartbeatResult,
    signature: signatureResult,
    explore: exploreResult,
    physicalStorage: {
      totalPhysicalFiles: physicalFilesResult.totalScanned,
      soundsCount: physicalFilesResult.soundsMap.size,
      videosCount: physicalFilesResult.videosMap.size,
      imagesCount: physicalFilesResult.imagesMap.size
    }
  };
}

module.exports = {
  collectFullPodReportData,
  getPodDbUrl,
  queryPodDb,
  scanPodPhysicalFiles,
  getPodStorageBaseDir,
  resolvePodStorageDir,
  resolvePodId,
  compareTopicList,
  collectTopicsComparison,
  collectHourlyHeartbeatTelemetry,
  auditSessionSignature,
  auditSessionExplore
};
