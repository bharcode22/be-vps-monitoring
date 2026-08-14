const { deployBatchPodAppServerStream } = require('./installationService');

/**
 * Register Socket.io event handler for real-time streamed batch installation
 */
function registerInstallationStreamHandlers(socket, io) {
  socket.on('start_batch_installation', async (payload) => {
    console.log(`[Socket.io Streamer] Batch installation request received from client ${socket.id}:`, payload);
    const { server_ids, env, app_configs } = payload || {};

    if (!server_ids || !Array.isArray(server_ids) || server_ids.length === 0) {
      socket.emit('installation_batch_error', { error: 'Server ID target wajib dipilih' });
      return;
    }

    if (!app_configs || !Array.isArray(app_configs) || app_configs.length === 0) {
      socket.emit('installation_batch_error', { error: 'Konfigurasi aplikasi wajib dipilih' });
      return;
    }

    socket.emit('installation_batch_start', {
      totalServers: server_ids.length,
      totalApps: app_configs.length,
      totalTasks: server_ids.length * app_configs.length
    });

    try {
      const result = await deployBatchPodAppServerStream({
        server_ids: server_ids.map(Number),
        env: env || 'dev',
        app_configs,
        onLog: (logChunk) => {
          socket.emit('installation_batch_log', { text: logChunk });
        }
      });

      socket.emit('installation_batch_complete', result);
    } catch (err) {
      console.error('[Socket.io Streamer] Error during batch deployment:', err.message);
      socket.emit('installation_batch_log', { text: `\n❌ ERROR FATAL: ${err.message}\n` });
      socket.emit('installation_batch_complete', { success: false, error: err.message });
    }
  });
}

module.exports = {
  registerInstallationStreamHandlers
};
