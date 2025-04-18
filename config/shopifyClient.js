const { shopifyApi, LATEST_API_VERSION } = require('@shopify/shopify-api');
const shopifyApiAdapter = require('@shopify/shopify-api/adapters/node');

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET,
  adminApiAccessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
  scopes: ['read_customers', 'write_customers', 'read_customer_metafields', 'write_customer_metafields'], // ✅ Add scopes
  hostName: (process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, ''),
  apiVersion: LATEST_API_VERSION,
  isEmbeddedApp: false,
  adapter: shopifyApiAdapter, // ✅ Adapter for Node.js runtime
});

module.exports = shopify;