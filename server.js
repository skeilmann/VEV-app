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

    const savedMap = { ...existingData.saved };
    console.log('Initial savedMap:', savedMap);

    // Process each favorite and fetch its variants
    for (const fav of favorites) {
      const productId = fav.productId;
      if (!productId) {
        console.warn('Skipping favorite: missing productId');
        continue;
      }

      try {
        console.log(`[DEBUG] Fetching product ${productId} from Shopify...`);
        const product = await Product.find({
          session,
          id: productId,
          fields: ['id', 'title', 'variants'],
        });

        if (!product) {
          console.error(`[ERROR] Failed to fetch product ${productId} from Shopify`);
          continue;
        }

        console.log(`[DEBUG] Product ${productId} data:`, {
          id: product.id,
          title: product.title,
          variants: product.variants
        });

        if (!Array.isArray(product.variants) || product.variants.length === 0) {
          console.error(`[ERROR] No variants found for product ${productId}`);
          continue;
        }

        const firstVariant = product.variants[0];
        if (!firstVariant || !firstVariant.id) {
          console.error(`[ERROR] Invalid variant data for product ${productId}`);
          continue;
        }

        const variantId = firstVariant.id.toString();
        console.log(`[DEBUG] Found variant ${variantId} for product ${productId}`);
        
        // Store in the exact format: { "productId": [variantId] }
        savedMap[productId] = [variantId];
        console.log(`[DEBUG] Updated savedMap for ${productId}:`, savedMap[productId]);
      } catch (error) {
        console.error(`[ERROR] Processing product ${productId}:`, error);
      }
    }

    // Ensure the data structure matches exactly
    const mergedData = {
      saved: savedMap,
      viewed: existingData.viewed || '',
      custom: existingData.custom || {},
    };

    console.log('[DEBUG] Final data to be stored in metafield:', JSON.stringify(mergedData, null, 2));

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
      console.log('[DEBUG] Updating existing metafield...');
      response = await Metafield.update({
        session,
        id: existingMeta.id,
        ...metafieldPayload,
      });
    } else {
      console.log('[DEBUG] Creating new metafield...');
      response = await new Metafield({ session }).create(metafieldPayload);
    }

    console.log('[DEBUG] Metafield update response:', response);

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