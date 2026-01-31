console.log('Starting server...');
require('dotenv').config();
const express = require('express');
const cors = require('cors');

// Route imports
const syncFavoritesRouter = require('./routes/syncFavorites');
const loyaltyRouter = require('./routes/loyalty');
const webhooksRouter = require('./routes/webhooks');

const app = express();
const port = process.env.PORT || 3000;

// Middleware
app.use(cors());

// Raw body middleware for webhook HMAC verification
// Must come before express.json() for webhook routes
app.use('/api/webhooks', express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf.toString('utf8');
  }
}));

// JSON body parser for all other routes
app.use(express.json());

// API Key validation middleware for non-webhook routes
const validateApiKey = (req, res, next) => {
  // Skip for webhooks (they use HMAC verification)
  if (req.path.startsWith('/api/webhooks')) {
    return next();
  }

  const apiKey = req.headers['x-api-key'];
  const validKey = process.env.API_SECRET_KEY;

  if (!validKey) {
    console.warn('API_SECRET_KEY not configured, skipping API key validation');
    return next();
  }

  if (apiKey !== validKey) {
    return res.status(401).json({
      success: false,
      message: 'Invalid or missing API key',
    });
  }

  next();
};

// Apply API key validation to /api routes (except webhooks)
app.use('/api/loyalty', validateApiKey);
app.use('/api/sync-favorites', validateApiKey);

// Routes
app.use('/api', syncFavoritesRouter);
app.use('/api/loyalty', loyaltyRouter);
app.use('/api/webhooks', webhooksRouter);

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '2.0.0',
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
