const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';

/**
 * Derive a 32-byte secret key consistently from environment variables
 */
function getDerivedKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || 'server_monitoring_secure_key_2026';
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt plain text using AES-256-GCM
 * Output format: enc:v1:<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
 * @param {string} text - Plain text to encrypt
 * @returns {string} - Ciphertext with prefix
 */
function encrypt(text) {
  if (!text || typeof text !== 'string') return text;
  if (text.startsWith(PREFIX)) return text; // Already encrypted

  try {
    const key = getDerivedKey();
    const iv = crypto.randomBytes(12); // 12-byte IV for AES-GCM
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag().toString('hex');
    return `${PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
  } catch (err) {
    console.error('❌ [crypto.encrypt] Encryption failed:', err.message);
    return text;
  }
}

/**
 * Decrypt AES-256-GCM ciphertext
 * @param {string} encryptedText - Formatted ciphertext
 * @returns {string} - Decrypted plaintext
 */
function decrypt(encryptedText) {
  if (!encryptedText || typeof encryptedText !== 'string') return encryptedText;
  if (!encryptedText.startsWith(PREFIX)) return encryptedText; // Plain text fallback

  try {
    const key = getDerivedKey();
    const parts = encryptedText.slice(PREFIX.length).split(':');
    if (parts.length !== 3) return encryptedText;

    const [ivHex, authTagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(cipherHex, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    console.error('❌ [crypto.decrypt] Decryption failed:', err.message);
    return encryptedText;
  }
}

/**
 * Check if a string is already encrypted with our format
 */
function isEncrypted(text) {
  return typeof text === 'string' && text.startsWith(PREFIX);
}

module.exports = {
  encrypt,
  decrypt,
  isEncrypted
};
