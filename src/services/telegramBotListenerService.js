const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');
const dbAsync = require('./db');
const { getTelegramAlertConfig } = require('./telegramAlertService');
const { collectFullPodReportData } = require('./report/podReportCollectorService');
const { generatePodPdfReport } = require('./report/podPdfGeneratorService');

let isPollingRunning = false;
let pollingAbortController = null;
let lastUpdateId = 0;

/**
 * Helper to escape HTML characters
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Send a text message to Telegram with optional inline keyboard
 */
async function sendTelegramReply(chatId, textHtml, replyMarkup = null) {
  const config = getTelegramAlertConfig();
  if (!config.botToken) return null;

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const body = {
    chat_id: chatId,
    text: textHtml,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };
  if (replyMarkup) {
    body.reply_markup = replyMarkup;
  }

  try {
    const res = await axios.post(url, body, { timeout: 10000 });
    return res.data?.result || null;
  } catch (err) {
    console.error('[Telegram Bot] Gagal mengirim balasan:', err.response?.data?.description || err.message);
    return null;
  }
}

/**
 * Edit an existing Telegram message
 */
async function editTelegramMessage(chatId, messageId, newTextHtml) {
  const config = getTelegramAlertConfig();
  if (!config.botToken) return null;

  const url = `https://api.telegram.org/bot${config.botToken}/editMessageText`;
  try {
    const res = await axios.post(url, {
      chat_id: chatId,
      message_id: messageId,
      text: newTextHtml,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    }, { timeout: 10000 });
    return res.data?.result || null;
  } catch (err) {
    console.warn('[Telegram Bot] Gagal mengedit pesan status:', err.response?.data?.description || err.message);
    return null;
  }
}

/**
 * Answer Telegram callback query (closes button loading spinner on user's phone)
 */
async function answerTelegramCallbackQuery(callbackQueryId, text = '') {
  const config = getTelegramAlertConfig();
  if (!config.botToken) return;

  const url = `https://api.telegram.org/bot${config.botToken}/answerCallbackQuery`;
  try {
    await axios.post(url, {
      callback_query_id: callbackQueryId,
      text: text || undefined
    }, { timeout: 5000 });
  } catch (_) { }
}

/**
 * Upload and send PDF Document to Telegram
 */
async function sendTelegramPdfDocument(chatId, filePath, fileName, captionHtml) {
  const config = getTelegramAlertConfig();
  if (!config.botToken) {
    throw new Error('Bot token Telegram belum dikonfigurasi.');
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendDocument`;
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('document', fs.createReadStream(filePath), {
    filename: fileName,
    contentType: 'application/pdf'
  });
  if (captionHtml) {
    form.append('caption', captionHtml);
    form.append('parse_mode', 'HTML');
  }

  const res = await axios.post(url, form, {
    headers: form.getHeaders(),
    timeout: 60000,
    maxContentLength: Infinity,
    maxBodyLength: Infinity
  });

  return res.data;
}

/**
 * Run full pipeline to generate report and dispatch PDF to Telegram
 */
async function runPodReportPipeline(podServer, chatId, triggerUser = 'Telegram User') {
  console.log(`🚀 [Telegram Report Pipeline] Menjalankan laporan untuk ${podServer.name} (ID: ${podServer.id}) dipicu oleh ${triggerUser}...`);

  // 1. Send initial progress message
  const initialMsg = await sendTelegramReply(
    chatId,
    `⏳ <b>Memproses Laporan Diagnostik: ${escapeHtml(podServer.name)}</b>\n\n` +
    `<i>1. Mengambil data skema topik (pod_topics & socket_topics)...\n` +
    `2. Mengumpulkan telemetri heartbeat 1 jam terakhir...\n` +
    `3. Mengaudit sesi Signature & Explore...\n` +
    `4. Memindai file fisik audio/video di disk POD via SSH...</i>\n\n` +
    `⚡ <i>Mohon tunggu beberapa saat...</i>`
  );

  const initialMsgId = initialMsg?.message_id;

  try {
    // 2. Collect full data
    const reportData = await collectFullPodReportData(podServer);

    // Update progress
    if (initialMsgId) {
      await editTelegramMessage(
        chatId,
        initialMsgId,
        `⏳ <b>Menyusun Berkas PDF: ${escapeHtml(podServer.name)}</b>\n\n` +
        `✅ Data berhasil dikumpulkan.\n` +
        `🎨 <i>Sedang merender layout PDF, grafik heartbeat vektor, dan checklist media...</i>`
      );
    }

    // 3. Generate PDF
    const { filePath, fileName, fileSizeBytes } = await generatePodPdfReport(reportData);

    const wibDate = new Date().toLocaleString('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }) + ' WIB';

    const healthScore = reportData.scores.overallHealthScore;
    const healthBadge = healthScore >= 85 ? '🟢 HEALTHY' : (healthScore >= 60 ? '🟡 WARNING' : '🔴 CRITICAL');

    // 4. Build rich caption
    const captionLines = [
      `📊 <b>LAPORAN DIAGNOSTIK: ${escapeHtml(podServer.name).toUpperCase()}</b>`,
      `📅 <b>Waktu:</b> ${wibDate} | 🏆 <b>Skor:</b> <b>${healthScore}%</b> (${healthBadge})`,
      '',
      `📡 <b>Topics Sync:</b> ${reportData.topics.podTopics.matchedCount}/${reportData.topics.podTopics.totalMaster} (${reportData.topics.overallSynced ? '✅ Match' : '⚠️ Ada Selisih'})`,
      `💓 <b>Heartbeat (1 Jam):</b> ${reportData.heartbeat.averageUptimePct}% Uptime • ${reportData.heartbeat.liveModulesCount}/${reportData.heartbeat.totalModulesTracked} Modul Online • ${(reportData.heartbeat.totalPacketsLastHour || 0).toLocaleString()} detak`,
      `📁 <b>Sumber Detak:</b> <code>${reportData.heartbeat.storageLocation || 'pod_storage/pods'}</code>`,
      `🎵 <b>Sesi Signature:</b> ${reportData.signature.totalFilesReady}/${reportData.signature.totalFilesChecked} File Siap (${reportData.signature.fileAvailabilityPct}%)`,
      `🧘 <b>Sesi Explore:</b> ${reportData.explore.totalFilesReady}/${reportData.explore.totalFilesChecked} File Siap (${reportData.explore.fileAvailabilityPct}%)`,
      `💾 <b>Penyimpanan POD:</b> ${reportData.physicalStorage.totalPhysicalFiles} file media di /home/pod/`,
      '',
      `📎 <i>Berkas PDF terlampir (${(fileSizeBytes / 1024).toFixed(1)} KB) dilengkapi grafik detak 12 interval waktu & checklist fisik.</i>`
    ];

    // 5. Send PDF Document
    await sendTelegramPdfDocument(chatId, filePath, fileName, captionLines.join('\n'));

    // 6. Delete or update initial progress message
    if (initialMsgId) {
      await editTelegramMessage(
        chatId,
        initialMsgId,
        `✅ <b>Laporan untuk ${escapeHtml(podServer.name)} berhasil dikirimkan di bawah!</b>`
      );
    }

    console.log(`✅ [Telegram Report Pipeline] Berhasil mengunggah ${fileName} ke Telegram chat ${chatId}`);
    return { success: true, fileName, filePath };
  } catch (err) {
    console.error(`❌ [Telegram Report Pipeline] Gagal membuat laporan untuk ${podServer.name}:`, err);
    if (initialMsgId) {
      await editTelegramMessage(
        chatId,
        initialMsgId,
        `❌ <b>Gagal membuat laporan untuk ${escapeHtml(podServer.name)}</b>\n\n` +
        `⚠️ <b>Error:</b> <code>${escapeHtml(err.message)}</code>\n\n` +
        `<i>Pastikan server POD dapat dijangkau via SSH dan database aktif.</i>`
      );
    } else {
      await sendTelegramReply(
        chatId,
        `❌ <b>Gagal membuat laporan untuk ${escapeHtml(podServer.name)}:</b> <code>${escapeHtml(err.message)}</code>`
      );
    }
    return { success: false, error: err.message };
  }
}

/**
 * Handle incoming /report command
 */
async function handleReportCommand(message) {
  const chatId = message.chat.id;
  const text = (message.text || '').trim();
  const fromUser = message.from ? `${message.from.first_name || ''} ${message.from.last_name || ''}`.trim() : 'Telegram User';

  // Extract argument after /report (e.g. "/report 36" or "/report POD 36")
  const parts = text.split(/\s+/);
  parts.shift(); // Remove command
  const queryArg = parts.join(' ').trim();

  // Fetch all POD servers
  const allPods = await dbAsync.all("SELECT id, name, code, host, pod_version FROM servers WHERE type = 'pod' ORDER BY id ASC");
  const podV3List = allPods.filter(s => {
    const ver = (s.pod_version || '').toLowerCase();
    const nameStr = (s.name || '').toLowerCase();
    return ver === 'v3' || nameStr.includes('v3') || (!ver.includes('v2') && !nameStr.includes('v2'));
  });

  if (podV3List.length === 0) {
    return await sendTelegramReply(
      chatId,
      '⚠️ <b>Tidak ada server POD V3 yang terdaftar di database sistem.</b>'
    );
  }

  // CASE A: User provided specific pod name/number: e.g. "/report 36" or "/report POD 36"
  if (queryArg) {
    const cleanQuery = queryArg.toLowerCase().replace(/[^a-z0-9]/g, '');
    const matchedPod = podV3List.find(p => {
      const pNameClean = (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const pCodeClean = (p.code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const pIdStr = String(p.id);
      return pNameClean.includes(cleanQuery) || pCodeClean.includes(cleanQuery) || pIdStr === cleanQuery;
    });

    if (matchedPod) {
      return await runPodReportPipeline(matchedPod, chatId, fromUser);
    } else {
      return await sendTelegramReply(
        chatId,
        `⚠️ <b>POD "${escapeHtml(queryArg)}" tidak ditemukan.</b>\n\n` +
        `Daftar POD V3 yang tersedia:\n` +
        podV3List.map(p => `• <b>${escapeHtml(p.name)}</b> (<code>/report ${p.name.replace(/\s+/g, '_')}</code>)`).join('\n')
      );
    }
  }

  // CASE B: User typed just "/report" without arguments -> Send interactive inline buttons!
  const inlineButtons = [];
  let currentRow = [];

  podV3List.forEach((pod, idx) => {
    currentRow.push({
      text: `📊 ${pod.name}`,
      callback_data: `action:report_pod:${pod.id}`
    });

    // 2 buttons per row for clean mobile layout
    if (currentRow.length === 2 || idx === podV3List.length - 1) {
      inlineButtons.push([...currentRow]);
      currentRow = [];
    }
  });

  const messageHtml = [
    '📋 <b>PILIH UNIT POD V3 UNTUK MEMBUAT LAPORAN:</b>',
    '',
    'Silakan tekan tombol unit POD di bawah ini, atau ketik langsung perintah:',
    'Contoh: <code>/report 36</code> atau <code>/report POD 36</code>',
    '',
    '<i>Sistem akan otomatis mengecek Topics, Heartbeat 1 jam terakhir, serta file sesi Signature & Explore.</i>'
  ].join('\n');

  return await sendTelegramReply(chatId, messageHtml, { inline_keyboard: inlineButtons });
}

/**
 * Handle incoming callback queries (inline buttons clicks)
 */
async function handleCallbackQuery(callbackQuery) {
  const data = callbackQuery.data || '';
  const message = callbackQuery.message;
  const chatId = message.chat.id;
  const fromUser = callbackQuery.from ? `${callbackQuery.from.first_name || ''} ${callbackQuery.from.last_name || ''}`.trim() : 'User';

  if (data.startsWith('action:report_pod:')) {
    const serverId = parseInt(data.replace('action:report_pod:', ''), 10);
    await answerTelegramCallbackQuery(callbackQuery.id, '⏳ Menyiapkan laporan...');

    const podServer = await dbAsync.get('SELECT * FROM servers WHERE id = ?', [serverId]);
    if (!podServer) {
      return await sendTelegramReply(chatId, `⚠️ Server dengan ID ${serverId} tidak ditemukan.`);
    }

    return await runPodReportPipeline(podServer, chatId, fromUser);
  }
}

/**
 * Process a batch of Telegram updates
 */
async function processTelegramUpdates(updates = []) {
  for (const update of updates) {
    lastUpdateId = Math.max(lastUpdateId, update.update_id);

    // 1. Handle incoming text message
    if (update.message && update.message.text) {
      const text = update.message.text.trim();
      if (text.startsWith('/report')) {
        await handleReportCommand(update.message);
      } else if (text.startsWith('/start') || text.startsWith('/help')) {
        const helpHtml = [
          '🤖 <b>BOT MONITORING & LAPORAN ARMADA REGENESIS POD</b>',
          '',
          'Perintah yang tersedia:',
          '• <code>/report</code> — Tampilkan menu tombol pilihan seluruh POD V3.',
          '• <code>/report &lt;nama_pod&gt;</code> — Buat laporan PDF langsung (Contoh: <code>/report 36</code>).',
          '',
          '<i>Laporan mencakup perbandingan tabel topics, grafik heartbeat 1 jam terakhir, serta audit ketersediaan file Signature & Explore.</i>'
        ].join('\n');
        await sendTelegramReply(update.message.chat.id, helpHtml);
      }
    }

    // 2. Handle callback query (inline button clicks)
    if (update.callback_query) {
      await handleCallbackQuery(update.callback_query);
    }
  }
}

/**
 * Single long-polling request to Telegram API
 */
async function pollTelegramUpdates() {
  const config = getTelegramAlertConfig();
  if (!config.botToken) {
    return;
  }

  const url = `https://api.telegram.org/bot${config.botToken}/getUpdates`;
  try {
    const res = await axios.get(url, {
      params: {
        offset: lastUpdateId + 1,
        timeout: 25,
        allowed_updates: JSON.stringify(['message', 'callback_query'])
      },
      timeout: 30000
    });

    const updates = res.data?.result || [];
    if (updates.length > 0) {
      await processTelegramUpdates(updates);
    }
  } catch (err) {
    // If polling timeout, it is expected in long-polling
    if (err.code !== 'ECONNABORTED' && !axios.isCancel(err)) {
      const errMsg = err.response?.data?.description || err.message;
      if (!errMsg.includes('timeout')) {
        console.warn('[Telegram Bot Polling] Warning:', errMsg);
      }
    }
  }
}

/**
 * Continuous Long-Polling loop
 */
async function startTelegramPollingLoop() {
  if (isPollingRunning) return;
  isPollingRunning = true;
  console.log('🤖 [Telegram Bot Listener] Layanan Telegram Long-Polling diaktifkan...');

  while (isPollingRunning) {
    try {
      await pollTelegramUpdates();
    } catch (e) {
      console.error('[Telegram Bot Polling] Unexpected loop error:', e.message);
      await new Promise(r => setTimeout(r, 5000));
    }
    // Brief spacing between polling cycles
    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Stop polling loop
 */
function stopTelegramPollingLoop() {
  isPollingRunning = false;
  if (pollingAbortController) {
    pollingAbortController.abort();
  }
}

/**
 * Initialize Telegram Bot Listener on startup
 */
function initTelegramBotListener() {
  const config = getTelegramAlertConfig();
  if (config.botToken) {
    startTelegramPollingLoop().catch(err => {
      console.error('[Telegram Bot Listener] Gagal memulai listener:', err.message);
    });
  } else {
    console.log('ℹ️ [Telegram Bot Listener] Bot token belum diset, listener standby.');
  }
}

module.exports = {
  initTelegramBotListener,
  startTelegramPollingLoop,
  stopTelegramPollingLoop,
  runPodReportPipeline,
  sendTelegramPdfDocument
};
