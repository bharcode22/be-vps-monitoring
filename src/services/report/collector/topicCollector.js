const { queryPodDb } = require('./podDbClient');

/**
 * Helper comparator for topic lists
 */
function compareTopicList(masterList, podList) {
  const masterMap = new Map();
  masterList.forEach(item => {
    const key = (item.topic || item.topic_name || item.name || '').trim();
    if (key) masterMap.set(key, item);
  });

  const podMap = new Map();
  podList.forEach(item => {
    const key = (item.topic || item.topic_name || item.name || '').trim();
    if (key) podMap.set(key, item);
  });

  const allKeys = Array.from(new Set([...masterMap.keys(), ...podMap.keys()])).sort();

  const comparison = allKeys.map(key => {
    const inMaster = masterMap.has(key);
    const inPod = podMap.has(key);
    const masterRow = masterMap.get(key) || null;
    const podRow = podMap.get(key) || null;

    let status = 'MATCH'; // MATCH | MISSING_IN_POD | EXTRA_IN_POD | MISMATCH
    if (inMaster && !inPod) {
      status = 'MISSING_IN_POD';
    } else if (!inMaster && inPod) {
      status = 'EXTRA_IN_POD';
    }

    return {
      topic: key,
      inMaster,
      inPod,
      status,
      masterRow,
      podRow
    };
  });

  const matchedCount = comparison.filter(c => c.status === 'MATCH').length;
  const missingInPodCount = comparison.filter(c => c.status === 'MISSING_IN_POD').length;
  const extraInPodCount = comparison.filter(c => c.status === 'EXTRA_IN_POD').length;

  return {
    totalMaster: masterList.length,
    totalPod: podList.length,
    matchedCount,
    missingInPodCount,
    extraInPodCount,
    isSynced: missingInPodCount === 0 && extraInPodCount === 0,
    rows: comparison
  };
}

/**
 * 1. Collect and Compare pod_topics & socket_topics between Master DB and POD DB
 */
async function collectTopicsComparison(masterPool, podServer) {
  let masterPodTopics = [];
  let masterSocketTopics = [];
  let podPodTopics = [];
  let podSocketTopics = [];

  // Query Master DB
  try {
    const resMasterPod = await masterPool.query('SELECT * FROM pod_topics ORDER BY id ASC');
    masterPodTopics = resMasterPod.rows || [];
  } catch (e) {
    try {
      const resFallback = await masterPool.query('SELECT * FROM pod_topic ORDER BY id ASC');
      masterPodTopics = resFallback.rows || [];
    } catch (_) { }
  }

  try {
    const resMasterSocket = await masterPool.query('SELECT * FROM socket_topics ORDER BY id ASC');
    masterSocketTopics = resMasterSocket.rows || [];
  } catch (e) {
    try {
      const resFallback = await masterPool.query('SELECT * FROM socket_topic ORDER BY id ASC');
      masterSocketTopics = resFallback.rows || [];
    } catch (_) { }
  }

  // Query POD DB
  try {
    podPodTopics = await queryPodDb(podServer, 'SELECT * FROM pod_topics ORDER BY id ASC');
    if (!podPodTopics || podPodTopics.length === 0) {
      podPodTopics = await queryPodDb(podServer, 'SELECT * FROM pod_topic ORDER BY id ASC');
    }
  } catch (_) { }

  try {
    podSocketTopics = await queryPodDb(podServer, 'SELECT * FROM socket_topics ORDER BY id ASC');
    if (!podSocketTopics || podSocketTopics.length === 0) {
      podSocketTopics = await queryPodDb(podServer, 'SELECT * FROM socket_topic ORDER BY id ASC');
    }
  } catch (_) { }

  const podTopicsComp = compareTopicList(masterPodTopics, podPodTopics);
  const socketTopicsComp = compareTopicList(masterSocketTopics, podSocketTopics);

  return {
    podTopics: podTopicsComp,
    socketTopics: socketTopicsComp,
    overallSynced: podTopicsComp.isSynced && socketTopicsComp.isSynced
  };
}

module.exports = {
  compareTopicList,
  collectTopicsComparison
};
