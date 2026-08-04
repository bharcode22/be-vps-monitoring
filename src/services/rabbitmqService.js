/**
 * Service to interact with RabbitMQ HTTP Management API
 */

/**
 * Fetch stats from a RabbitMQ server
 * @param {Object} server - RabbitMQ server connection info
 */
async function fetchRabbitMqStatus(server) {
  const { host, port, username, password } = server;
  const baseUrl = `http://${host}:${port}`;
  const auth = Buffer.from(`${username || 'guest'}:${password || ''}`).toString('base64');
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Accept': 'application/json'
  };

  try {
    // 1. Fetch overview
    const overviewRes = await fetch(`${baseUrl}/api/overview`, { headers, signal: AbortSignal.timeout(5000) });
    if (!overviewRes.ok) {
      throw new Error(`Overview API returned status ${overviewRes.status}`);
    }
    const overview = await overviewRes.json();

    // 2. Fetch queues
    const queuesRes = await fetch(`${baseUrl}/api/queues`, { headers, signal: AbortSignal.timeout(5000) });
    if (!queuesRes.ok) {
      throw new Error(`Queues API returned status ${queuesRes.status}`);
    }
    const queuesData = await queuesRes.json();

    // 3. Fetch consumers
    let consumersData = [];
    try {
      const consumersRes = await fetch(`${baseUrl}/api/consumers`, { headers, signal: AbortSignal.timeout(5000) });
      if (consumersRes.ok) {
        consumersData = await consumersRes.json();
      }
    } catch (e) {
      console.warn(`Failed to fetch consumers for ${host}:${port}`, e.message);
    }

    // Map consumers by queue name
    const consumersMap = {};
    consumersData.forEach(c => {
      const qName = c.queue?.name;
      if (qName) {
        if (!consumersMap[qName]) {
          consumersMap[qName] = [];
        }
        consumersMap[qName].push({
          consumerTag: c.consumer_tag,
          active: c.active,
          ackRequired: c.ack_required,
          peerHost: c.channel_details?.peer_host || 'Unknown',
          peerPort: c.channel_details?.peer_port,
          connectionName: c.channel_details?.connection_name || '',
          node: c.channel_details?.node || ''
        });
      }
    });

    // Formulate final queues list
    const queues = queuesData.map(q => ({
      name: q.name,
      status: q.state || 'idle',
      messages: q.messages || 0,
      messagesReady: q.messages_ready || 0,
      messagesUnacknowledged: q.messages_unacknowledged || 0,
      consumersCount: q.consumers || 0,
      consumers: consumersMap[q.name] || [],
      rates: {
        publish: q.message_stats?.publish_details?.rate || 0,
        deliver: q.message_stats?.deliver_details?.rate || 0,
        ack: q.message_stats?.ack_details?.rate || 0
      }
    }));

    return {
      status: 'online',
      version: overview.rabbitmq_version,
      clusterName: overview.cluster_name,
      totals: {
        messages: overview.queue_totals?.messages || 0,
        messagesReady: overview.queue_totals?.messages_ready || 0,
        messagesUnacknowledged: overview.queue_totals?.messages_unacknowledged || 0,
        publishRate: overview.queue_totals?.messages_details?.rate || 0
      },
      queues
    };
  } catch (err) {
    return {
      status: 'offline',
      error: err.message,
      queues: [],
      totals: { messages: 0, messagesReady: 0, messagesUnacknowledged: 0, publishRate: 0 }
    };
  }
}

module.exports = {
  fetchRabbitMqStatus
};
