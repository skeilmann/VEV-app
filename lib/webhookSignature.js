/**
 * Shopify webhook HMAC check.
 * Shopify signs the raw request body with the app's API secret (client secret)
 * and sends the base64 digest in X-Shopify-Hmac-SHA256.
 * rawBody should be the raw Buffer (a string is accepted for tests).
 */

const crypto = require('crypto');

function verifyWebhookSignature(rawBody, hmacHeader, secret) {
  if (!secret || typeof hmacHeader !== 'string' || !hmacHeader) return false;
  if (!Buffer.isBuffer(rawBody) && typeof rawBody !== 'string') return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest();
  const given = Buffer.from(hmacHeader, 'base64');

  if (given.length !== expected.length) return false;
  return crypto.timingSafeEqual(expected, given);
}

module.exports = { verifyWebhookSignature };
