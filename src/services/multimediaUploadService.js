const MASTER_API_BASE = process.env.MASTER_API_BASE;
const MASTER_USERNAME = process.env.MASTER_API_USERNAME;
const MASTER_PASSWORD = process.env.MASTER_API_PASSWORD;

// Token cache in memory
let cachedToken = null;
let tokenExpiresAt = 0;

/**
 * Obtain JWT token from Master API (with auto-caching)
 */
async function getAuthToken() {
  const now = Date.now();
  if (cachedToken && tokenExpiresAt > now + 60000) {
    return cachedToken;
  }

  const loginUrl = `${MASTER_API_BASE}/auth/login`;

  try {
    const res = await fetch(loginUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        usernameOrEmail: MASTER_USERNAME,
        password: MASTER_PASSWORD
      })
    });

    const data = await res.json();
    if (!res.ok || !data?.token) {
      throw new Error(data?.message || data?.error || `Gagal login ke Master API (HTTP ${res.status})`);
    }

    cachedToken = data.token;
    // Set expiry to 23 hours from now (standard JWT 24h)
    tokenExpiresAt = now + 23 * 60 * 60 * 1000;
    return cachedToken;
  } catch (err) {
    console.error('❌ Error authenticating to Master API:', err.message);
    throw err;
  }
}

module.exports = {
  getAuthToken
};
