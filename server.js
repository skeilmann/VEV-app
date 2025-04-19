console.log('Starting server...');
console.trace('Tracking module import...');
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
  const clientKey = req.headers['x-api-key'];
  const serverKey = process.env.API_SECRET_KEY;
  if (!serverKey || clientKey !== serverKey) {
    return res.status(403).json({ success: false, message: 'Forbidden: Invalid API key' });
  }
  next();
});

// Routes
app.use('/api', syncFavoritesRouter);

const { Session } = require('@shopify/shopify-api');
const Metafield = shopify.rest.Metafield;
const Product = shopify.rest.Product;

app.post('/api/sync-favorites', async (req, res) => {
  const { customerId, favorites } = req.body;

  if (!customerId || !Array.isArray(favorites)) {
    return res.status(400).json({ success: false, message: 'Invalid request data' });
  }

  try {
    const session = new Session({
      id: 'offline',
      shop: process.env.SHOPIFY_SHOP,
      state: 'active',
      isOnline: false,
      accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      scope: shopify.config.scopes.join(','),
    });

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

    const savedMap = { ...existingData.saved };

    // Process each favorite and fetch its variants
    for (const { productId } of favorites) {
      if (!productId) {
        console.warn('Skipping favorite: missing productId');
        continue;
      }

      try {
        // Fetch the product with its variants
        const product = await Product.find({
          session,
          id: productId,
          fields: ['id', 'variants'],
        });

        if (!product) {
          console.warn(`Product ${productId} not found`);
          continue;
        }

        // Get the first variant ID
        const variantId = product.variants[0]?.id;
        
        if (!variantId) {
          console.warn(`No variants found for product ${productId}`);
          continue;
        }

        // Store the variant ID with the product in the exact format
        savedMap[productId] = [variantId.toString()];
      } catch (error) {
        console.error(`Error fetching product ${productId}:`, error);
        continue;
      }
    }

    const mergedData = {
      saved: savedMap,
      viewed: existingData.viewed || '',
      custom: existingData.custom || {},
    };

    console.log('Merged result:', JSON.stringify(mergedData, null, 2));

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
});

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