/**
 * Customer token
 *
 * Proves which logged-in customer is calling the API without putting any
 * secret in the browser. The Shopify theme renders the token server-side in
 * Liquid for the logged-in customer only:
 *
 *   message = "<customerId>:<expiresUnixSeconds>"
 *   sig     = hex(HMAC-SHA256(CUSTOMER_TOKEN_SECRET, message))
 *   token   = "<customerId>.<expiresUnixSeconds>.<sig>"
 *
 * Liquid: {{ message | hmac_sha256: secret }} produces the same hex digest.
 * The secret lives in a shop metafield (theme side) and in the
 * CUSTOMER_TOKEN_SECRET env var (server side); it never reaches the page.
 */

const crypto = require('crypto');

const TOKEN_RE = /^(\d{1,20})\.(\d{1,12})\.([a-f0-9]{64})$/;

// The theme issues 24h tokens; allow a little clock skew, nothing more.
const MAX_LIFETIME_SECONDS = 26 * 60 * 60;

function sign(secret, customerId, expires) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${customerId}:${expires}`, 'utf8')
    .digest('hex');
}

/**
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowSeconds]
 * @returns {string|null} customer ID when the token is valid, otherwise null
 */
function verifyCustomerToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret || typeof token !== 'string') return null;

  const match = TOKEN_RE.exec(token);
  if (!match) return null;

  const [, customerId, expiresStr, sig] = match;
  const expires = Number(expiresStr);

  if (expires <= nowSeconds) return null;
  if (expires - nowSeconds > MAX_LIFETIME_SECONDS) return null;

  const expected = Buffer.from(sign(secret, customerId, expiresStr), 'hex');
  const given = Buffer.from(sig, 'hex');
  if (expected.length !== given.length) return null;
  if (!crypto.timingSafeEqual(expected, given)) return null;

  return customerId;
}

/** Used by tests and by scripts that need to create a token. */
function createCustomerToken(secret, customerId, expires) {
  return `${customerId}.${expires}.${sign(secret, String(customerId), String(expires))}`;
}

module.exports = { verifyCustomerToken, createCustomerToken };
