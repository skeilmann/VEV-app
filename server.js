require('dotenv').config();

const express = require('express');
const cors = require('cors');
const syncFavoritesRouter = require('./routes/syncFavorites');
const { shopifyApi, LATEST_API_VERSION, restResources } = require('@shopify/shopify-api');

const app = express();
const port = process.env.PORT || 3000;

// Initialize Shopify
const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
  hostName: process.env.SHOPIFY_SHOP.replace(/^https?:\/\//, ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  scopes: [
    'read_customers',
    'write_customers',
    'read_customer_metafields',
    'write_customer_metafields'
  ],
  restResources,
});

module.exports = shopify;

// Middleware
app.use(cors());
app.use(express.json());

// Security middleware: API key check
app.use('/api', (req, res, next) => {
  const clientKey = decodeURIComponent(req.headers['x-api-key'] || '');
  const serverKey = process.env.API_SECRET_KEY;
  

  if (!serverKey) {
    return res.status(500).json({ success: false, message: 'Server configuration error' });
  }

  if (!clientKey || clientKey.trim() !== serverKey.trim()) {
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  
  next();
});

// Get current favorites endpoint
app.get('/api/favorites/:customerId', async (req, res) => {
  const { customerId } = req.params;

  try {
    const session = new Session({
      id: 'offline',
      shop: process.env.SHOPIFY_SHOP,
      state: 'active',
      isOnline: false,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      scope: 'read_customers,write_customers,read_customer_metafields,write_customer_metafields'
    });

    const existingMetafields = await Metafield.all({
      session,
      owner_resource: 'customer',
      owner_id: customerId,
    });

    const existingMeta = existingMetafields.find(mf =>
      mf.namespace === 'cad' && mf.key === 'customer_products'
    );

    res.json({
      success: true,
      data: existingMeta ? JSON.parse(existingMeta.value) : null
    });
  } catch (error) {
    console.error('Error fetching favorites:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch favorites', error: error.message });
  }
});

// Routes
app.use('/api', syncFavoritesRouter);

// Health check endpoint
app.get('/ping', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    success: false,
    message: 'Internal server error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});