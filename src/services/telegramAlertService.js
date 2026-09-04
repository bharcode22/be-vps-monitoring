const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getHeartbeatThresholdsConfig } = require('./podHeartbeatConfigService');

const CONFIG_FILE_PATH = path.join(__dirname, '..', 'data', 'telegram_alert_config.json');

const DEFAULT_CONFIG = {
  enabled: true,
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  alertOnlyDead: true,
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
      alertOnlyDead: parsed.alertOnlyDead !== undefined ? Boolean(parsed.alertOnlyDead) : true,
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
      alertOnlyDead: config.alertOnlyDead !== undefined ? Boolean(config.alertOnlyDead) : true,
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
 * Send a generic message to the configured Telegram chat
 */
async function sendRawTelegramMessage(textHtml) {
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
    const errMsg = err.response?.data?.description || err.message;
    console.error('[Telegram] Gagal mengirim pesan ke Telegram:', errMsg);
    return { sent: false, error: errMsg };
  }
}

/**
 * Send Heartbeat DEAD alert strictly when status is DEAD
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

  // Format time in WIB (Jakarta)
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WIB';

  let messageHtml = '';

  // 1. Pod-Wide Outage (Aggregated All Modules DEAD)
  if (moduleId === 0 || /all modules/i.test(moduleName)) {
    messageHtml = [
      '🔥 <b>[CRITICAL] SELURUH MODUL POD OFFLINE</b> 🔥',
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      '🔌 <b>Cakupan:</b> Seluruh Modul Terputus Serentak',
      '⚠️ <b>Status:</b> 🔴 <b>POD DOWN / OFFLINE</b>',
      `⏱️ <b>Ambang Batas Dead:</b> ≥ ${thresholds.deadSec} detik`,
      `⏳ <b>Durasi Terputus:</b> ${durationSeconds} detik`,
      `🕒 <b>Waktu Insiden:</b> ${timeStr}`,
      '',
      '⚠️ <i>Peringatan otomatis: Seluruh modul pod mati secara bersamaan. Kemungkinan unit POD kehilangan catu daya, atau broker MQTT / jaringan terputus total.</i>'
    ].join('\n');
  } else {
    // 2. Individual Module DEAD Outage
    messageHtml = [
      '🚨 <b>[ALERT] MODUL HEARTBEAT DEAD</b> 🚨',
      '',
      `🏢 <b>Pod:</b> <code>${escapeHtml(serverName)}</code>`,
      `🔌 <b>Modul:</b> <code>ID ${moduleId}</code> - <b>${escapeHtml(moduleName)}</b>`,
      '⚠️ <b>Status:</b> 🔴 <b>DEAD (Tidak Ada Sinyal Detak)</b>',
      `⏱️ <b>Ambang Batas Dead:</b> ≥ ${thresholds.deadSec} detik`,
      `⏳ <b>Durasi Mati:</b> ${durationSeconds} detik`,
      `📡 <b>Counter Terakhir:</b> <code>#${lastHb !== null && lastHb !== undefined ? lastHb : '—'}</code>`,
      `🕒 <b>Waktu Insiden:</b> ${timeStr}`,
      '',
      'ℹ️ <i>Peringatan otomatis: Modul tidak merespons melebihi batas waktu toleransi. Mohon periksa koneksi hardware / serial port modul terkait.</i>'
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
 * Send a test notification to verify Telegram Bot integration
 */
async function sendTestTelegramMessage(senderName = 'Admin Dashboard') {
  const config = getTelegramAlertConfig();
  const timeStr = new Date().toLocaleString('id-ID', {
    timeZone: 'Asia/Jakarta',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }) + ' WIB';

  const testHtml = [
    '🔔 <b>[TEST NOTIFIKASI] SISTEM MONITORING HEARTBEAT</b> 🔔',
    '',
    '✅ Bot Telegram berhasil terhubung dengan Server Monitoring POD!',
    `🏢 <b>Grup Target:</b> Supergroup HB monitor (<code>${config.chatId}</code>)`,
    `👤 <b>Pemicu Tes:</b> ${escapeHtml(senderName)}`,
    `🕒 <b>Waktu Kirim:</b> ${timeStr}`,
    '🎯 <b>Aturan:</b> <i>Hanya mengirim notifikasi saat status modul berstatus DEAD (≥ 30s).</i>',
    '',
    '🚀 <i>Sistem siap beroperasi dan memantau armada POD secara real-time.</i>'
  ].join('\n');

  return await sendRawTelegramMessage(testHtml);
}

module.exports = {
  getTelegramAlertConfig,
  saveTelegramAlertConfig,
  sendDeadHeartbeatAlert,
  sendTestTelegramMessage,
  sendRawTelegramMessage
};
