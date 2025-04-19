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

// Security middleware: API key check
app.use('/api', (req, res, next) => {
  const clientKey = req.headers['x-api-key'];
  const serverKey = process.env.API_SECRET_KEY;
  if (!serverKey || clientKey !== serverKey) {
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  next();
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
  console.log(`Server running on port ${port}`);
});

const { customerId, favorites } = req.body;

if (!customerId || !Array.isArray(favorites)) {
  return res.status(400).json({ success: false, message: 'Invalid request data' });
}

try {
  // Step 1: Get existing metafield value (if any)
  const session = new Session({
    id: 'offline',
    shop: process.env.SHOPIFY_SHOP,
    state: 'active',
    isOnline: false,
    accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
    scope: shopify.config.scopes.join(','),
  });

  const { Metafield } = await import('@shopify/shopify-api/rest/admin/2023-10.js');

  const existingMetafields = await Metafield.all({
    session,
    owner_resource: 'customer',
    owner_id: customerId,
  });

  const existingMeta = existingMetafields.find(mf =>
    mf.namespace === 'cad' && mf.key === 'customer_products'
  );

  const existingData = existingMeta
    ? JSON.parse(existingMeta.value)
    : { saved: {}, viewed: '', custom: {} };

  console.log('Merging favorites:', {
    existingData,
    newFavorites: favorites,
  });

  // Step 2: Merge new favorites into existing data
  const savedMap = { ...existingData.saved };

  favorites.forEach(({ productId, variantId }) => {
    if (!savedMap[productId]) {
      savedMap[productId] = [];
    }
    if (variantId && !savedMap[productId].includes(variantId)) {
      savedMap[productId].push(variantId);
    }
  });

  const mergedData = {
    saved: savedMap,
    viewed: existingData.viewed || '',
    custom: existingData.custom || {},
  };

  console.log('Merged result:', JSON.stringify(mergedData, null, 2));

  // Step 3: Create or update metafield
  const metafieldPayload = {
    key: 'customer_products',
    namespace: 'cad',
    type: 'json',
    value: JSON.stringify(mergedData),
    owner_resource: 'customer',
    owner_id: customerId,
  };

  let response;

  if (existingMeta) {
    response = await Metafield.update({
      session,
      id: existingMeta.id,
      ...metafieldPayload,
    });
  } else {
    response = await new Metafield({ session }).create(metafieldPayload);
  }

  console.log('Update metafield response:', response);

  res.json({ success: true, updated: response });
} catch (error) {
  console.error('Error syncing favorites:', error);
  res.status(500).json({ success: false, message: 'Failed to sync favorites', error: error.message });
}