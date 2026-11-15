/**
 * Small in-memory fixed-window rate limiter (single process, no dependencies).
 * Protects the app's shared Shopify Admin API budget from being used up by
 * request floods, which would otherwise make webhooks fail.
 */

function rateLimit({ windowMs, max, key = (req) => req.ip }) {
  const hits = new Map();

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, entry] of hits) {
      if (entry.reset <= now) hits.delete(k);
    }
  }, windowMs);
  sweep.unref();

  return (req, res, next) => {
    const k = key(req);
    const now = Date.now();
    let entry = hits.get(k);
    if (!entry || entry.reset <= now) {
      entry = { count: 0, reset: now + windowMs };
      hits.set(k, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ success: false, message: 'Too many requests' });
    }
    next();
  };
}

module.exports = { rateLimit };
