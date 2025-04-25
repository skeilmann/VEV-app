console.log('Starting server...');
console.trace('Tracking module import...');
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const syncFavoritesRouter = require('./routes/syncFavorites');
const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');

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
});

module.exports = shopify;

// Middleware
app.use(cors());
app.use(express.json());

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
  console.log(`Server running on port ${port}`);
});

app.post('/api/sync-favorites', async (req, res) => {
  const { customerId, favorites } = req.body;

  if (!customerId || !Array.isArray(favorites)) {
    return res.status(400).json({ success: false, message: 'Invalid request data' });
  }

  try {
    const savedMap = favorites.reduce((acc, fav) => {
      acc[fav.productId] = fav.variantId ? [fav.variantId] : [];
      return acc;
    }, {});

    const metafieldPayload = {
      key: 'customer_products',
      namespace: 'cad',
      type: 'json',
      value: JSON.stringify({
        saved: savedMap,
        viewed: '',
        custom: {}
      }),
      owner_resource: 'customer',
      owner_id: customerId
    };

    const { Metafield } = await import('@shopify/shopify-api/rest/admin/2023-10');
    const metafield = new Metafield({ session: shopify.session });
    await metafield.create(metafieldPayload);

    res.json({ success: true });
  } catch (error) {
    console.error('Error syncing favorites:', error);
    res.status(500).json({ success: false, message: 'Error syncing favorites' });
  }
});