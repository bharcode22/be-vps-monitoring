const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHeartbeatThresholdsConfig } = require('./podHeartbeatConfigService');

const CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'telegram_alert_config.json');

const DEFAULT_CONFIG = {
  enabled: true,
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  alertOnlyDead: false,
  notifyDead: true,
  notifyRecoveredContinue: true,
  notifyRecoveredRestart: true,
  notifyRecoveredJump: true,
  cooldownMinutes: 5
};

// In-memory cache for config
let cachedConfig = null;

// Rate-limiting cooldown map: `${serverId}_${moduleId}` -> timestamp (ms)
const alertCooldownMap = new Map();

/**
 * Ensure config file exists and directory is present
 */
function ensureConfigExists() {
  const dir = path.dirname(CONFIG_FILE_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(CONFIG_FILE_PATH)) {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8');
  }
}

/**
 * Get current Telegram alert config
 */
function getTelegramAlertConfig() {
  if (cachedConfig) return cachedConfig;
  try {
    ensureConfigExists();
    const raw = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    cachedConfig = {
      enabled: parsed.enabled !== undefined ? Boolean(parsed.enabled) : true,
      botToken: parsed.botToken || DEFAULT_CONFIG.botToken,
      chatId: parsed.chatId || DEFAULT_CONFIG.chatId,
      alertOnlyDead: parsed.alertOnlyDead !== undefined ? Boolean(parsed.alertOnlyDead) : false,
      notifyDead: parsed.notifyDead !== undefined ? Boolean(parsed.notifyDead) : true,
      notifyRecoveredContinue: parsed.notifyRecoveredContinue !== undefined ? Boolean(parsed.notifyRecoveredContinue) : true,
      notifyRecoveredRestart: parsed.notifyRecoveredRestart !== undefined ? Boolean(parsed.notifyRecoveredRestart) : true,
      notifyRecoveredJump: parsed.notifyRecoveredJump !== undefined ? Boolean(parsed.notifyRecoveredJump) : true,
      cooldownMinutes: Number(parsed.cooldownMinutes) || DEFAULT_CONFIG.cooldownMinutes
    };
    return cachedConfig;
  } catch (err) {
    console.error('Error reading telegram config:', err.message);
    cachedConfig = { ...DEFAULT_CONFIG };
    return cachedConfig;
  }
}

/**
 * Save updated Telegram alert config
 */
function saveTelegramAlertConfig(config) {
  try {
    ensureConfigExists();
    const current = getTelegramAlertConfig();
    const updated = {
      enabled: config.enabled !== undefined ? Boolean(config.enabled) : current.enabled,
      botToken: config.botToken ? String(config.botToken).trim() : current.botToken,
      chatId: config.chatId ? String(config.chatId).trim() : current.chatId,
      alertOnlyDead: config.alertOnlyDead !== undefined ? Boolean(config.alertOnlyDead) : current.alertOnlyDead,
      notifyDead: config.notifyDead !== undefined ? Boolean(config.notifyDead) : current.notifyDead,
      notifyRecoveredContinue: config.notifyRecoveredContinue !== undefined ? Boolean(config.notifyRecoveredContinue) : current.notifyRecoveredContinue,
      notifyRecoveredRestart: config.notifyRecoveredRestart !== undefined ? Boolean(config.notifyRecoveredRestart) : current.notifyRecoveredRestart,
      notifyRecoveredJump: config.notifyRecoveredJump !== undefined ? Boolean(config.notifyRecoveredJump) : current.notifyRecoveredJump,
      cooldownMinutes: Math.max(1, Number(config.cooldownMinutes) || 5)
    };
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(updated, null, 2), 'utf-8');
    cachedConfig = updated;
    return updated;
  } catch (err) {
    console.error('Error saving telegram config:', err.message);
    throw err;
  }
}

/**
 * Helper to escape HTML characters for Telegram HTML mode
 */
function escapeHtml(text) {
  if (text === null || text === undefined) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Rate-limited message dispatch queue for Telegram API
 * Prevents HTTP 429 Too Many Requests when multiple modules die at once.
 * Spaced by >= 1100ms per message to the chat with automatic retry on 429.
 */
const messageQueue = [];
let isQueueProcessing = false;
const TELEGRAM_DISPATCH_DELAY_MS = 1100;

/**
 * Enqueue a message to Telegram with automatic retry on 429
 */
function enqueueTelegramMessage(textHtml) {
  return new Promise((resolve) => {
    messageQueue.push({ textHtml, resolve, retryCount: 0 });
    processTelegramQueue();
  });
}

async function processTelegramQueue() {
  if (isQueueProcessing) return;
  if (messageQueue.length === 0) return;

  isQueueProcessing = true;

  while (messageQueue.length > 0) {
    const item = messageQueue.shift();
    try {
      const result = await executeSendTelegramMessage(item.textHtml);
      if (result.sent) {
        item.resolve(result);
      } else if (result.rateLimited && item.retryCount < 3) {
        item.retryCount++;
        const waitMs = (result.retryAfterSec ? result.retryAfterSec * 1000 : 2000) + 200;
        console.warn(`[Telegram] Rate limited (429). Menunggu ${waitMs}ms sebelum mencoba kirim ulang pesan...`);
        await new Promise((r) => setTimeout(r, waitMs));
        messageQueue.unshift(item); // Put back to front of queue
        continue;
      } else {
        item.resolve(result);
      }
    } catch (err) {
      console.error('[Telegram Queue] Error saat memproses pesan:', err.message);
      item.resolve({ sent: false, error: err.message });
    }

    // Rate limit spacer between messages to the same chat
    if (messageQueue.length > 0) {
      await new Promise((r) => setTimeout(r, TELEGRAM_DISPATCH_DELAY_MS));
    }
  }

  isQueueProcessing = false;
}

/**
 * Direct HTTP POST to Telegram API
 */
async function executeSendTelegramMessage(textHtml) {
  const config = getTelegramAlertConfig();
  if (!config.enabled) {
    return { sent: false, reason: 'DISABLED' };
  }
  if (!config.botToken || !config.chatId) {
    console.warn('[Telegram] Bot token atau Chat ID belum dikonfigurasi.');
    return { sent: false, reason: 'MISSING_CREDENTIALS' };
  }

  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  try {
    const res = await axios.post(
      url,
      {
        chat_id: config.chatId,
        text: textHtml,
        parse_mode: 'HTML',
        disable_web_page_preview: true
      },
      { timeout: 7000 }
    );
    return { sent: true, data: res.data };
  } catch (err) {
    const status = err.response?.status;
    const retryAfterSec = err.response?.data?.parameters?.retry_after;
    const errMsg = err.response?.data?.description || err.message;

    if (status === 429) {
      return { sent: false, rateLimited: true, retryAfterSec, error: errMsg };
    }

    console.error('[Telegram] Gagal mengirim pesan ke Telegram:', errMsg);
    return { sent: false, error: errMsg };
  }
}

/**
 * Send a generic message to the configured Telegram chat (via safe queue)
 */
async function sendRawTelegramMessage(textHtml) {
  return await enqueueTelegramMessage(textHtml);
}

/**
 * Clear cooldown when a module recovers back to healthy state (LIVE)
 * This ensures that if the module dies again, it immediately triggers an alert just like the audio alarm chime
 */
function clearDeadAlertCooldown(serverId, moduleId) {
  if (moduleId !== undefined && moduleId !== null) {
    const key = `${serverId}_${moduleId}`;
    alertCooldownMap.delete(key);
  } else {
    // Clear all modules for that serverId
    for (const key of alertCooldownMap.keys()) {
      if (key.startsWith(`${serverId}_`)) {
        alertCooldownMap.delete(key);
      }
    }
  }
}

/**
 * Send Heartbeat DEAD alert strictly when status is DEAD (Single module)
 * Ignores FROZEN, DELAY, and RECOVERED as requested
 */
async function sendDeadHeartbeatAlert(alertData) {
  if (!alertData) return { sent: false, reason: 'NO_DATA' };

  // STRICT REQUIREMENT: Only send when status is DEAD
  if (alertData.alertType !== 'DEAD') {
    return { sent: false, reason: 'NOT_DEAD_IGNORED' };
  }

  const config = getTelegramAlertConfig();
  if (!config.enabled) {
    return { sent: false, reason: 'TELEGRAM_ALERT_DISABLED' };
  }

  const serverId = alertData.serverId || 0;
  const moduleId = alertData.moduleId !== undefined ? alertData.moduleId : 0;
  const cooldownKey = `${serverId}_${moduleId}`;
  const now = Date.now();
  const cooldownMs = (config.cooldownMinutes || 5) * 60 * 1000;

  // Anti-spam cooldown per Pod and Module
  const lastSent = alertCooldownMap.get(cooldownKey) || 0;
  if (now - lastSent < cooldownMs) {
    const remainingSec = Math.ceil((cooldownMs - (now - lastSent)) / 1000);
    console.log(`[Telegram] Alert DEAD untuk Pod ${serverId} Mod ${moduleId} dilewati (cooldown ${remainingSec}s tersisa).`);
    return { sent: false, reason: 'IN_COOLDOWN', remainingSec };
  }

  const serverName = alertData.serverName || `Pod ${serverId}`;
  const moduleName = alertData.moduleName || `Modul ${moduleId}`;
  const durationSeconds = alertData.durationSeconds || alertData.downtimeSeconds || 0;
  const lastHb = alertData.lastHb;
  const thresholds = getHeartbeatThresholdsConfig();

  // Format time in WITA (Makassar)
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WITA';

  const rootCauseCategory = alertData.rootCauseCategory || (moduleId === 0 ? 'HOST_NETWORK_OFFLINE' : 'HARDWARE_MODULE_FAULT');
  const diagnosticHint = alertData.diagnosticHint || '';
  const pingMs = alertData.pingMs !== undefined && alertData.pingMs !== null ? `${alertData.pingMs} ms` : null;

  const rootCauseBadge = rootCauseCategory === 'HOST_NETWORK_OFFLINE'
    ? '🟠 <b>GANGGUAN JARINGAN / POD HOST OFFLINE</b>'
    : '🔴 <b>KEGAGALAN FISIK MODUL HARDWARE (USB/POWER)</b>';

  let messageHtml = '';

  // 1. Pod-Wide Outage (Aggregated All Modules DEAD)
  if (moduleId === 0 || /all modules/i.test(moduleName)) {
    messageHtml = [
      `🔥 <b>[CRITICAL] SELURUH MODUL ${escapeHtml(serverName).toUpperCase()} OFFLINE</b> 🔥`,
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      '🔌 <b>Cakupan:</b> Seluruh Modul Terputus Serentak',
      '⚠️ <b>Status:</b> 🔴 <b>POD DOWN / OFFLINE</b>',
      `🌐 <b>Konektivitas Host:</b> <code>${pingMs ? `${pingMs} (Online)` : 'Host Unreachable / Timeout'}</code>`,
      `🛠️ <b>Prediksi Masalah:</b> ${rootCauseBadge}`,
      `⏱️ <b>Ambang Batas Dead:</b> ≥ ${thresholds.deadSec} detik`,
      `⏳ <b>Durasi Terputus:</b> ${durationSeconds} detik`,
      `🕒 <b>Waktu Insiden:</b> ${timeStr}`,
      '',
      `💡 <b>Rekomendasi Tindakan:</b> <i>${escapeHtml(diagnosticHint || 'Periksa catu daya listrik utama unit POD dan koneksi router jaringan.')}</i>`
    ].join('\n');
  } else {
    // 2. Individual Module DEAD Outage
    const modTitle = escapeHtml(moduleName).toUpperCase();
    messageHtml = [
      `🚨 <b>[ALERT] MODUL ${modTitle} DEAD</b> 🚨`,
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      `🔌 <b>Modul:</b> <code>ID ${moduleId}</code> - <b>${escapeHtml(moduleName)}</b>`,
      '⚠️ <b>Status:</b> 🔴 <b>DEAD (Tidak Ada Sinyal Detak)</b>',
      `🌐 <b>Konektivitas Host:</b> <code>${pingMs ? `${pingMs} (Online)` : 'Host Unreachable / Timeout'}</code>`,
      `🛠️ <b>Prediksi Masalah:</b> ${rootCauseBadge}`,
      `⏱️ <b>Ambang Batas Dead:</b> ≥ ${thresholds.deadSec} detik`,
      `⏳ <b>Durasi Mati:</b> ${durationSeconds} detik`,
      `📡 <b>Counter Terakhir:</b> <code>#${lastHb !== null && lastHb !== undefined ? lastHb : '—'}</code>`,
      `🕒 <b>Waktu Insiden:</b> ${timeStr}`,
      '',
      `💡 <b>Rekomendasi Tindakan:</b> <i>${escapeHtml(diagnosticHint || 'Periksa koneksi fisik kabel USB / serial port modul terkait.')}</i>`
    ].join('\n');
  }

  const result = await sendRawTelegramMessage(messageHtml);
  if (result.sent) {
    alertCooldownMap.set(cooldownKey, now);
    console.log(`✅ [Telegram] Notifikasi DEAD terkirim untuk ${serverName} - ${moduleName}`);
  }
  return result;
}

/**
 * Send Consolidated / Batch Heartbeat DEAD alert when 2 or more modules die in the same pod in a check
 * e.g. when 2 modules are switched off at once
 */
async function sendBatchDeadHeartbeatAlert({ serverId, serverName, modules = [], durationSeconds = 0 }) {
  if (!modules || modules.length === 0) return { sent: false, reason: 'NO_MODULES' };

  // If only 1 module, forward to standard individual alert
  if (modules.length === 1) {
    const single = modules[0];
    return await sendDeadHeartbeatAlert({
      serverId,
      serverName,
      moduleId: single.moduleId,
      moduleName: single.modName || single.moduleName,
      lastHb: single.record?.hb,
      durationSeconds: single.elapsedSec || durationSeconds,
      alertType: 'DEAD'
    });
  }

  const config = getTelegramAlertConfig();
  if (!config.enabled) {
    return { sent: false, reason: 'TELEGRAM_ALERT_DISABLED' };
  }

  const now = Date.now();
  const cooldownMs = (config.cooldownMinutes || 5) * 60 * 1000;

  // Filter modules that are not in cooldown
  const eligibleModules = modules.filter(m => {
    const cooldownKey = `${serverId}_${m.moduleId}`;
    const lastSent = alertCooldownMap.get(cooldownKey) || 0;
    return (now - lastSent >= cooldownMs);
  });

  if (eligibleModules.length === 0) {
    console.log(`[Telegram] Batch DEAD untuk ${serverName} (${modules.length} modul) dilewati karena seluruh modul masih dalam cooldown.`);
    return { sent: false, reason: 'ALL_IN_COOLDOWN' };
  }

  const sName = serverName || `Pod ${serverId}`;
  const thresholds = getHeartbeatThresholdsConfig();

  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WITA';

  // Build list of dead modules
  const moduleLines = eligibleModules.map((m, idx) => {
    const modId = m.moduleId;
    const modName = m.modName || m.moduleName || `Modul ${modId}`;
    const hbVal = m.record?.hb !== null && m.record?.hb !== undefined ? `#${m.record.hb}` : '—';
    const durSec = m.elapsedSec || durationSeconds || thresholds.deadSec;
    return `  ${idx + 1}. <b>${escapeHtml(modName)}</b> (<code>ID: ${modId}</code>) — Macet di <code>${hbVal}</code> [${durSec}s]`;
  }).join('\n');

  const { getPodLatencySnapshot } = require('./podPingService');
  const podLat = typeof getPodLatencySnapshot === 'function' ? getPodLatencySnapshot(serverId) : null;
  const isHostOnline = podLat ? (podLat.stats?.isOnline && podLat.stats?.currentPingMs !== null) : true;
  const batchPingMs = podLat?.stats?.currentPingMs !== null && podLat?.stats?.currentPingMs !== undefined ? `${podLat.stats.currentPingMs} ms` : null;

  const batchRootCause = isHostOnline
    ? '🔴 <b>KEGAGALAN FISIK MODUL HARDWARE (USB/POWER)</b>'
    : '🟠 <b>GANGGUAN JARINGAN / POD HOST OFFLINE</b>';
  const batchHint = isHostOnline
    ? `Host POD terbukti aktif (Ping: ${batchPingMs || 'OK'}). Terindikasi USB Hub atau pasokan daya modul serial terganggu.`
    : 'Host POD tidak merespons ping. Terindikasi koneksi jaringan Wi-Fi/VPN terputus atau catu daya listrik unit POD mati.';

  const messageHtml = [
    `🚨 <b>[ALERT] ${escapeHtml(batchTitle)}</b> 🚨`,
    '',
    `🏢 <b>Pod:</b> <code>${escapeHtml(sName)}</code>`,
    `⚠️ <b>Total Modul Mati:</b> ${eligibleModules.length} Modul Terputus Bersamaan`,
    `🌐 <b>Konektivitas Host:</b> <code>${batchPingMs ? `${batchPingMs} (Online)` : 'Host Unreachable / Timeout'}</code>`,
    `🛠️ <b>Prediksi Masalah:</b> ${batchRootCause}`,
    `⏱️ <b>Ambang Batas Dead:</b> ≥ ${thresholds.deadSec} detik`,
    `🕒 <b>Waktu Insiden:</b> ${timeStr}`,
    '',
    '📋 <b>Rincian Modul Bermasalah:</b>',
    moduleLines,
    '',
    `💡 <b>Rekomendasi Tindakan:</b> <i>${escapeHtml(batchHint)}</i>`
  ].join('\n');

  const result = await sendRawTelegramMessage(messageHtml);
  if (result.sent) {
    eligibleModules.forEach(m => {
      alertCooldownMap.set(`${serverId}_${m.moduleId}`, now);
    });
    console.log(`✅ [Telegram] Notifikasi Batch DEAD terkirim untuk ${sName}: ${eligibleModules.length} modul.`);
  }
  return result;
}

/**
 * Send Heartbeat RECOVERED alert (BERLANJUT, RESTART, or LOMPAT)
 * Triggered when a module that was DEAD starts ticking normally again
 */
async function sendRecoveredHeartbeatAlert(alertData) {
  if (!alertData) return { sent: false, reason: 'NO_DATA' };

  const config = getTelegramAlertConfig();
  if (!config.enabled) {
    console.log(`[Telegram] Alert RECOVERED untuk Pod ${alertData.serverId} Modul ${alertData.moduleId} dilewati (Telegram Alert DISABLED di config).`);
    return { sent: false, reason: 'TELEGRAM_ALERT_DISABLED' };
  }
  if (config.alertOnlyDead && !config.notifyRecoveredContinue && !config.notifyRecoveredRestart && !config.notifyRecoveredJump) {
    console.log(`[Telegram] Alert RECOVERED untuk Pod ${alertData.serverId} Modul ${alertData.moduleId} dilewati (alertOnlyDead=true dan semua flag pemulihan false).`);
    return { sent: false, reason: 'ALERT_ONLY_DEAD_CONFIGURED' };
  }

  const recoveryType = alertData.recoveryType || 'BERLANJUT';

  if (recoveryType === 'BERLANJUT' && config.notifyRecoveredContinue === false) {
    console.log(`[Telegram] Alert RECOVERED BERLANJUT dilewati karena notifyRecoveredContinue=false.`);
    return { sent: false, reason: 'NOTIFY_CONTINUE_DISABLED' };
  }
  if (recoveryType === 'RESTART' && config.notifyRecoveredRestart === false) {
    console.log(`[Telegram] Alert RECOVERED RESTART dilewati karena notifyRecoveredRestart=false.`);
    return { sent: false, reason: 'NOTIFY_RESTART_DISABLED' };
  }
  if (recoveryType === 'LOMPAT' && config.notifyRecoveredJump === false) {
    console.log(`[Telegram] Alert RECOVERED LOMPAT dilewati karena notifyRecoveredJump=false.`);
    return { sent: false, reason: 'NOTIFY_JUMP_DISABLED' };
  }

  const serverId = alertData.serverId || 0;
  const moduleId = alertData.moduleId !== undefined ? alertData.moduleId : 0;
  const serverName = alertData.serverName || `Pod ${serverId}`;
  const moduleName = alertData.moduleName || `Modul ${moduleId}`;
  const durationSeconds = alertData.durationSeconds || alertData.downtimeSeconds || 0;
  const beforeHb = alertData.beforeHb !== null && alertData.beforeHb !== undefined ? `#${alertData.beforeHb}` : '—';
  const afterHb = alertData.afterHb !== null && alertData.afterHb !== undefined ? `#${alertData.afterHb}` : '—';
  const hbDiff = alertData.hbDiff;
  const diffStr = (hbDiff !== null && hbDiff !== undefined && hbDiff > 0) ? ` (+${hbDiff} detak)` : '';

  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WITA';

  const modTitle = escapeHtml(moduleName).toUpperCase();
  let messageHtml = '';

  if (recoveryType === 'RESTART') {
    messageHtml = [
      `🔄 <b>[PULIH - RESTART] MODUL ${modTitle} REBOOT DARI AWAL</b> 🔄`,
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      `🔌 <b>Modul:</b> <code>ID ${moduleId}</code> - <b>${escapeHtml(moduleName)}</b>`,
      '📊 <b>Pola Pemulihan:</b> 🔄 <b>RESTART / RESET DARI NOL</b>',
      `⏳ <b>Total Downtime:</b> ${durationSeconds} detik`,
      `📡 <b>Transisi Counter:</b> Dari <code>${beforeHb}</code> ➔ <code>${afterHb}</code> (Reset)`,
      `🕒 <b>Waktu Pulih:</b> ${timeStr}`,
      '',
      '🛠️ <b>Diagnosa:</b> <i>Modul microcontroller (MCU) atau driver mengalami restart dari awal. Terindikasi drop catu daya (brownout), kabel USB terputus sesaat, atau restart proses driver oleh supervisor.</i>',
      '💡 <b>Rekomendasi Tindakan:</b> <i>Periksa kestabilan catu daya 5V/12V dan konektor fisik USB modul terkait.</i>'
    ].join('\n');
  } else if (recoveryType === 'LOMPAT') {
    messageHtml = [
      `⚠️ <b>[PULIH - LOMPAT] MODUL ${modTitle} PULIH DENGAN JEDA DETAK</b> ⚠️`,
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      `🔌 <b>Modul:</b> <code>ID ${moduleId}</code> - <b>${escapeHtml(moduleName)}</b>`,
      `📊 <b>Pola Pemulihan:</b> ⚠️ <b>LOMPAT (${hbDiff || '?'} Detak Terlewat)</b>`,
      `⏳ <b>Total Downtime:</b> ${durationSeconds} detik`,
      `📡 <b>Transisi Counter:</b> Dari <code>${beforeHb}</code> ➔ <code>${afterHb}</code>${diffStr}`,
      `🕒 <b>Waktu Pulih:</b> ${timeStr}`,
      '',
      '🛠️ <b>Diagnosa:</b> <i>Hardware fisik modul tetap berdetak normal selama jeda, namun beberapa paket detak terlewat / drop di jaringan WiFi/LAN atau broker MQTT.</i>',
      '💡 <b>Rekomendasi Tindakan:</b> <i>Periksa kualitas koneksi jaringan dan stabilitas broker MQTT.</i>'
    ].join('\n');
  } else {
    // Default: BERLANJUT
    messageHtml = [
      `✅ <b>[PULIH - BERLANJUT] MODUL ${modTitle} KEMBALI AKTIF</b> ✅`,
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      `🔌 <b>Modul:</b> <code>ID ${moduleId}</code> - <b>${escapeHtml(moduleName)}</b>`,
      '📊 <b>Pola Pemulihan:</b> 🟢 <b>BERLANJUT (KONTINU / TANPA REBOOT)</b>',
      `⏳ <b>Total Downtime:</b> ${durationSeconds} detik`,
      `📡 <b>Transisi Counter:</b> Dari <code>${beforeHb}</code> ➔ <code>${afterHb}</code>${diffStr}`,
      `🕒 <b>Waktu Pulih:</b> ${timeStr}`,
      '',
      '🛠️ <b>Diagnosa:</b> <i>Hardware MCU fisik TIDAK reboot. Detak berlanjut normal setelah jeda transmisi sesaat (buffer serial / jitter thread OS).</i>'
    ].join('\n');
  }

  const result = await sendRawTelegramMessage(messageHtml);
  if (result.sent) {
    console.log(`✅ [Telegram] Notifikasi RECOVERED (${recoveryType}) terkirim untuk ${serverName} - ${moduleName}`);
  }
  return result;
}

/**
 * Send Consolidated / Batch Heartbeat RECOVERED alert when 2 or more modules in the same Pod recover simultaneously
 */
async function sendBatchRecoveredHeartbeatAlert({ serverId, serverName, modules = [] }) {
  if (!modules || modules.length === 0) return { sent: false, reason: 'NO_MODULES' };

  if (modules.length === 1) {
    return await sendRecoveredHeartbeatAlert(modules[0]);
  }

  const config = getTelegramAlertConfig();
  if (!config.enabled) {
    return { sent: false, reason: 'TELEGRAM_ALERT_DISABLED' };
  }
  if (config.alertOnlyDead && !config.notifyRecoveredContinue && !config.notifyRecoveredRestart && !config.notifyRecoveredJump) {
    return { sent: false, reason: 'ALERT_ONLY_DEAD_CONFIGURED' };
  }

  const sName = serverName || `Pod ${serverId}`;
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WITA';

  const modLines = modules.map((m, idx) => {
    const mName = m.modName || m.moduleName || `Modul ${m.moduleId}`;
    const bHb = m.beforeHb !== null && m.beforeHb !== undefined ? `#${m.beforeHb}` : '—';
    const aHb = m.afterHb !== null && m.afterHb !== undefined ? `#${m.afterHb}` : '—';
    const badge = m.recoveryType === 'RESTART'
      ? '🔄 RESTART'
      : (m.recoveryType === 'LOMPAT' ? '⚠️ LOMPAT' : '🟢 KONTINU');
    const dt = m.durationSeconds || m.downtimeSeconds || 0;
    return `  ${idx + 1}. <b>${escapeHtml(mName)}</b> (<code>ID ${m.moduleId}</code>): ${badge} [<code>${bHb} ➔ ${aHb}</code>] (${dt}s)`;
  }).join('\n');

  const messageHtml = [
    `✅ <b>[PULIH - BATCH] ${modules.length} MODUL ${escapeHtml(sName).toUpperCase()} KEMBALI AKTIF</b> ✅`,
    '',
    `🏢 <b>Pod:</b> <code>${escapeHtml(sName)}</code>`,
    `📊 <b>Total Modul Pulih:</b> ${modules.length} Modul Kembali Berdetak Bersamaan`,
    `🕒 <b>Waktu Pulih:</b> ${timeStr}`,
    '',
    '📋 <b>Rincian Modul yang Pulih:</b>',
    modLines,
    '',
    '🚀 <i>Seluruh modul terkait telah kembali mengirimkan sinyal detak secara normal ke server.</i>'
  ].join('\n');

  const result = await sendRawTelegramMessage(messageHtml);
  if (result.sent) {
    console.log(`✅ [Telegram] Notifikasi Batch RECOVERED terkirim untuk ${sName}: ${modules.length} modul.`);
  }
  return result;
}

/**
 * Send a test notification to verify Telegram Bot integration
 * Supports testType: 'DEAD' | 'RECOVERED_CONTINUE' | 'RECOVERED_RESTART' | 'BATCH_RECOVERED'
 */
async function sendTestTelegramMessage(senderName = 'Admin Dashboard', testType = 'DEAD') {
  if (testType === 'RECOVERED_CONTINUE' || testType === 'CONTINUE') {
    return await sendRecoveredHeartbeatAlert({
      serverId: 99,
      serverName: 'POD TEST (V3)',
      moduleId: 508,
      moduleName: 'mod_chair',
      recoveryType: 'BERLANJUT',
      beforeHb: 4520,
      afterHb: 4522,
      hbDiff: 2,
      durationSeconds: 28
    });
  }

  if (testType === 'RECOVERED_RESTART' || testType === 'RESTART') {
    return await sendRecoveredHeartbeatAlert({
      serverId: 99,
      serverName: 'POD TEST (V3)',
      moduleId: 508,
      moduleName: 'mod_chair',
      recoveryType: 'RESTART',
      beforeHb: 4520,
      afterHb: 1,
      hbDiff: null,
      durationSeconds: 42
    });
  }

  if (testType === 'BATCH_RECOVERED') {
    return await sendBatchRecoveredHeartbeatAlert({
      serverId: 99,
      serverName: 'POD TEST (V3)',
      modules: [
        { moduleId: 508, moduleName: 'mod_chair', recoveryType: 'RESTART', beforeHb: 4520, afterHb: 1, durationSeconds: 45 },
        { moduleId: 504, moduleName: 'mod_sound', recoveryType: 'BERLANJUT', beforeHb: 3200, afterHb: 3202, durationSeconds: 20 },
        { moduleId: 503, moduleName: 'mod_master_pilot', recoveryType: 'BERLANJUT', beforeHb: 1800, afterHb: 1801, durationSeconds: 20 }
      ]
    });
  }

  const config = getTelegramAlertConfig();
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Makassar',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WITA';

  const testHtml = [
    '🔔 <b>[TEST NOTIFIKASI] SISTEM MONITORING HEARTBEAT</b> 🔔',
    '',
    '✅ Bot Telegram berhasil terhubung dengan Server Monitoring POD!',
    `🏢 <b>Grup Target:</b> Supergroup HB monitor (<code>${config.chatId}</code>)`,
    `👤 <b>Pemicu Tes:</b> ${escapeHtml(senderName)}`,
    `🕒 <b>Waktu Kirim:</b> ${timeStr}`,
    '🎯 <b>Aturan:</b> <i>Notifikasi aktif untuk modul DEAD, serta pemulihan BERLANJUT & RESTART.</i>',
    '',
    '🚀 <i>Sistem siap memantau armada POD secara real-time.</i>'
  ].join('\n');

  return await sendRawTelegramMessage(testHtml);
}

module.exports = {
  getTelegramAlertConfig,
  saveTelegramAlertConfig,
  sendDeadHeartbeatAlert,
  sendBatchDeadHeartbeatAlert,
  sendRecoveredHeartbeatAlert,
  sendBatchRecoveredHeartbeatAlert,
  clearDeadAlertCooldown,
  sendTestTelegramMessage,
  sendRawTelegramMessage
};
