const { compareAllPodTopics, fetchTopicsFromPod, syncMissingTopics } = require('../services/podTopicService');
const { publishMqttMessage, getMqttClient, normalizeBrokerUrl } = require('../services/mqttSnifferService');
const dbAsync = require('../services/db');

/**
 * GET /api/pod-topics/matrix
 * Returns topic consistency matrix across all POD V3 instances
 */
async function getPodTopicMatrix(req, res) {
  try {
    const data = await compareAllPodTopics();
    res.json({ success: true, data });
  } catch (err) {
    console.error('Error fetching POD topic matrix:', err);
    res.status(500).json({ success: false, error: err.message || 'Gagal mengambil matriks topic POD' });
  }
}

/**
 * GET /api/pod-topics/:serverId
 * Returns topic details for a single POD server
 */
async function getPodTopicDetail(req, res) {
  try {
    const { serverId } = req.params;
    const server = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!server) {
      return res.status(404).json({ success: false, error: 'Server POD tidak ditemukan' });
    }

    const data = await fetchTopicsFromPod(server);
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message || 'Gagal mengambil detail topic server' });
  }
}

/**
 * POST /api/pod-topics/sync
 * Sync missing topics to target PODs
 */
async function syncPodTopics(req, res) {
  try {
    const { sourceServerId, targetServerIds, topicKeys, type } = req.body;
    const result = await syncMissingTopics({ sourceServerId, targetServerIds, topicKeys, type });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error syncing POD topics:', err);
    res.status(500).json({ success: false, error: err.message || 'Gagal melakukan sinkronisasi topic' });
  }
}

/**
 * POST /api/pod-topics/test-publish
 * Publish a test message to MQTT broker (supports targeting specific POD)
 */
async function testPublishMqtt(req, res) {
  try {
    const { topic, payload, qos = 0, retain = false, serverId, brokerHost, brokerUrl } = req.body;
    const result = await publishMqttMessage({ topic, payload, qos, retain, serverId, brokerHost, brokerUrl });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error publishing test MQTT packet:', err);
    res.status(500).json({ success: false, error: err.message || 'Gagal mem-publish pesan MQTT' });
  }
}

/**
 * POST /api/pod-topics/register
 * Register a new topic to one or all POD databases
 */
async function registerPodTopic(req, res) {
  try {
    const { topic, type, description, targetServerIds } = req.body;
    const result = await registerTopicToPods({ topic, type, description, targetServerIds });
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Error registering POD topic:', err);
    res.status(500).json({ success: false, error: err.message || 'Gagal mendaftarkan topic' });
  }
}

/**
 * GET /api/pod-topics/mqtt-status
 * Check active MQTT broker status
 */
async function getMqttBrokerStatus(req, res) {
  try {
    const { serverId, host, brokerUrl } = req.query;
    let targetUrl = brokerUrl;
    if (!targetUrl && (serverId || host)) {
      if (serverId) {
        const srv = await dbAsync.get('SELECT host FROM servers WHERE id = ?', [serverId]);
        if (srv && srv.host) targetUrl = `tcp://${srv.host}:1883`;
      } else if (host) {
        targetUrl = `tcp://${host}:1883`;
      }
    }

    const finalUrl = normalizeBrokerUrl(targetUrl || 'tcp://127.0.0.1:1883');
    const client = getMqttClient(finalUrl);
    res.json({
      success: true,
      data: {
        connected: client ? client.connected : false,
        brokerUrl: finalUrl
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getPodTopicMatrix,
  getPodTopicDetail,
  syncPodTopics,
  registerPodTopic,
  testPublishMqtt,
  getMqttBrokerStatus
};
