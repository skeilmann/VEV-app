const shopify = require('../config/shopifyClient');

class ShopifyService {
  constructor() {
    const shop = process.env.SHOPIFY_SHOP.replace(/^https?:\/\//, '').replace(/\/$/, '');
    
    this.client = new shopify.clients.Rest({
      session: {
        shop,
        accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
    });
  }

  async getCustomerMetafield(customerId) {
    try {
      const response = await this.client.get({
        path: `customers/${customerId}/metafields.json`,
        query: {
          namespace: 'cad',
          key: 'customer_products'
        },
      });

      return response.body.metafields[0] || null;
    } catch (error) {
      console.error('Error fetching customer metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
        headers: error.response?.headers
      });
      throw error;
    }
  }

  async createCustomerMetafield(customerId, value) {
    try {
      const response = await this.client.post({
        path: `customers/${customerId}/metafields.json`,
        data: {
          metafield: {
            namespace: 'cad',
            key: 'customer_products',
            type: 'json',
            value: JSON.stringify(value),
          },
        },
      });

      return response.body.metafield;
    } catch (error) {
      console.error('Error creating customer metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
        headers: error.response?.headers
      });
      throw error;
    }
  }

  async updateCustomerMetafield(customerId, metafieldId, value) {
    try {
      const response = await this.client.put({
        path: `customers/${customerId}/metafields/${metafieldId}.json`,
        data: {
          metafield: {
            value: JSON.stringify(value),
          },
        },
      });

      return response.body.metafield;
    } catch (error) {
      console.error('Error updating customer metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
        headers: error.response?.headers
      });
      throw error;
    }
  }

  async fetchProductVariant(productId) {
    try {
      const response = await this.client.get({
        path: `products/${productId}.json`,
      });
      const product = response.body.product;

      if (!product) {
        console.error(`[ERROR] Failed to fetch product ${productId} from Shopify`);
        return null;
      }

      if (!Array.isArray(product.variants) || product.variants.length === 0) {
        console.error(`[ERROR] No variants found for product ${productId}`);
        return null;
      }

      const firstVariant = product.variants[0];
      if (!firstVariant || !firstVariant.id) {
        console.error(`[ERROR] Invalid variant data for product ${productId}`);
        return null;
      }

      const variantId = firstVariant.id.toString();
      return variantId;
    } catch (error) {
      console.error(`[ERROR] Processing product ${productId}:`, {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
        headers: error.response?.headers
      });
      // Return null or throw, depending on desired error handling
      return null; 
    }
  }
  
  async fetchAndMergeFavorites(existingData, newFavoritesInput) {
    const mergedData = existingData || {
      saved: {},
      viewed: '',
      custom: {},
    };

    // Ensure saved is an object
    if (typeof mergedData.saved !== 'object' || mergedData.saved === null) {
        mergedData.saved = {};
    }

    for (const fav of newFavoritesInput) {
      const productId = fav.productId;
      if (!productId) {
        continue;
      }

      const variantId = await this.fetchProductVariant(productId);

      if (variantId) {
        const productIdStr = String(productId); // Ensure product ID is string for key consistency
        const variantIdStr = String(variantId); // Ensure variant ID is string

        if (!mergedData.saved[productIdStr]) {
          mergedData.saved[productIdStr] = [];
        }
        
        // Add variant only if it's not already present
        if (!mergedData.saved[productIdStr].includes(variantIdStr)) {
          mergedData.saved[productIdStr].push(variantIdStr);
        }
      }
    }
    
    // Overwrite the entire saved object with the desired format {productId: [variantId]}
    // Based on the requirement from server.js logic: { "productId": [variantId] }
    // This assumes we only want the *first* variant found for each *newly favorited* product.
    // If merging existing variants is needed, this logic needs adjustment.
    const finalSavedMap = { ...mergedData.saved }; 
    for (const fav of newFavoritesInput) {
        const productId = fav.productId;
        if (!productId) continue;
        const variantId = await this.fetchProductVariant(productId); // Re-fetch might be inefficient, consider storing result from loop above
        if (variantId) {
            finalSavedMap[String(productId)] = [String(variantId)];
        }
    }
    mergedData.saved = finalSavedMap;

    return mergedData;
  }

  mergeFavorites(existingData, newFavorites) {
    const mergedData = existingData || {
      saved: {},
      viewed: '',
      custom: {},
    };

    newFavorites.forEach(({ productId, variantId }) => {
      if (!mergedData.saved[productId]) {
        mergedData.saved[productId] = [];
      }
      if (variantId) {
        // Convert variantId to string to ensure consistent data type
        const variantIdStr = String(variantId);
        if (!mergedData.saved[productId].includes(variantIdStr)) {
          mergedData.saved[productId].push(variantIdStr);
        }
      }
    });

    return mergedData;
  }
}

module.exports = new ShopifyService(); 