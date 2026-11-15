require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { rateLimit } = require('./lib/rateLimit');

// Route imports
const syncFavoritesRouter = require('./routes/syncFavorites');
const loyaltyRouter = require('./routes/loyalty');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const port = process.env.PORT || 3000;

// CORS: only the store's own domains may call the API from a browser.
// ALLOWED_ORIGINS is a comma-separated list, e.g.
// https://vev.md,https://www.vev.md,https://wcp2a0-1c.myshopify.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
if (allowedOrigins.length === 0) {
  console.warn('ALLOWED_ORIGINS is empty: browsers on other sites cannot call the API');
}
app.use(
  cors({
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  })
);

// Behind Caddy/nginx: trust the first proxy for client IPs
app.set('trust proxy', 1);

// Raw body for webhook HMAC verification (must run before express.json)
app.use('/api/webhooks', express.json({
  limit: '1mb',
  verify: (req, res, buf) => {
    req.rawBody = Buffer.from(buf); // raw bytes, exactly as Shopify signed them
  }
}));

// JSON body parser for all other routes
app.use(express.json({ limit: '50kb' }));

// Customer routes authenticate on the route itself with a signed customer
// token (lib/auth.js). /api/loyalty/config is public; webhooks check Shopify's
// HMAC signature (routes/webhooks.js).

// Rate limits (per IP) keep request floods from using up the Shopify API budget
app.use(['/api/loyalty', '/api/sync-favorites'], rateLimit({ windowMs: 60 * 1000, max: 30 }));
app.use('/api/webhooks', rateLimit({ windowMs: 60 * 1000, max: 600 }));

// Routes
app.use('/api', syncFavoritesRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/webhooks', webhooksRouter);

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.1.0',
    features: ['favorites', 'loyalty'],
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

module.exports = app;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log('Available routes:');
    console.log('  GET  /ping - Health check');
    console.log('  POST /api/sync-favorites - Sync customer favorites');
    console.log('  GET  /api/loyalty/balance - Get loyalty balance');
    console.log('  GET  /api/loyalty/config - Get loyalty configuration');
    console.log('  POST /api/loyalty/redeem - Redeem points for discount');
    console.log('  POST /api/webhooks/orders-paid - Shopify order paid webhook');
    console.log('  POST /api/webhooks/refunds-create - Shopify refund webhook');
  });
}
