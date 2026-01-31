const shopify = require('../config/shopifyClient');

class ShopifyService {
  constructor() {
    const shop = process.env.SHOPIFY_SHOP.replace(/^https?:\/\//, '').replace(/\/$/, '');
    console.log('Initializing Shopify client with shop:', shop);
    
    this.client = new shopify.clients.Rest({
      session: {
        shop,
        accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
    });
  }

  // Fetches the first available variant ID for a product
  async getFirstVariantId(productId) {
    try {
      console.log('Fetching product details for productId:', productId);
      const response = await this.client.get({
        path: `products/${productId}.json`,
        query: { fields: 'variants' }, // Only fetch variants to be efficient
      });

      if (response.body.product && response.body.product.variants && response.body.product.variants.length > 0) {
        const firstVariantId = response.body.product.variants[0].id;
        console.log('Found first variant ID:', firstVariantId, 'for product:', productId);
        return firstVariantId;
      }
      console.warn('No variants found for product:', productId);
      return null;
    } catch (error) {
       // Handle 404 specifically for products not found
       if (error.response && error.response.status === 404) {
         console.warn(`Product with ID ${productId} not found.`);
         return null; 
       } 
      console.error(`Error fetching product ${productId} details:`, {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });
      // Decide if you want to throw or return null based on how critical this is
      // Returning null allows the process to continue for other products
      return null; 
    }
  }

  async getCustomerMetafield(customerId) {
    try {
      console.log('Fetching metafields for customer:', customerId);
      const response = await this.client.get({
        path: `customers/${customerId}/metafields.json`,
        query: {
          namespace: 'cad',
          key: 'customer_products'
        },
      });

      console.log('Metafields response:', JSON.stringify(response.body, null, 2));
      return response.body.metafields[0] || null;
    } catch (error) {
      // Handle 404 for customer not found
       if (error.response && error.response.status === 404) {
         console.warn(`Customer with ID ${customerId} not found.`);
         // Decide if you should throw or return null. If the customer must exist, throw.
         // Throwing makes sense here as we can't update a non-existent customer.
         throw new Error(`Customer ${customerId} not found`);
       }
      console.error('Error fetching customer metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
        headers: error.response?.headers
      });
      throw error; // Re-throw other errors
    }
  }

  async createCustomerMetafield(customerId, value) {
    try {
      console.log('Creating metafield for customer:', customerId, 'with value:', JSON.stringify(value));
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

      console.log('Create metafield response:', JSON.stringify(response.body, null, 2));
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
      console.log('Updating metafield:', metafieldId, 'for customer:', customerId, 'with value:', JSON.stringify(value));
      const response = await this.client.put({
        path: `customers/${customerId}/metafields/${metafieldId}.json`,
        data: {
          metafield: {
            value: JSON.stringify(value),
          },
        },
      });

      console.log('Update metafield response:', JSON.stringify(response.body, null, 2));
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

  // ============================================
  // Generic metafield methods (for loyalty, etc.)
  // ============================================

  /**
   * Get shop-level metafield by namespace and key
   */
  async getShopMetafield(namespace, key) {
    try {
      console.log('Fetching shop metafield:', namespace, key);
      const response = await this.client.get({
        path: 'metafields.json',
        query: {
          namespace: namespace,
          key: key,
        },
      });

      const metafields = response.body.metafields || [];
      const targetMetafield = metafields.find(mf =>
        mf.namespace === namespace && mf.key === key
      );

      if (targetMetafield) {
        console.log('Found shop metafield:', namespace, key);
        return targetMetafield;
      }

      console.log(`No shop metafield found with namespace '${namespace}' and key '${key}'`);
      return null;
    } catch (error) {
      console.error('Error fetching shop metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Get customer metafield by namespace and key (generic version)
   */
  async getCustomerMetafieldByNamespaceKey(customerId, namespace, key) {
    try {
      console.log('Fetching metafield for customer:', customerId, 'namespace:', namespace, 'key:', key);

      const response = await this.client.get({
        path: `customers/${customerId}/metafields.json`,
      });

      const metafields = response.body.metafields || [];
      const targetMetafield = metafields.find(mf =>
        mf.namespace === namespace && mf.key === key
      );

      if (targetMetafield) {
        console.log('Found metafield by namespace/key:', JSON.stringify(targetMetafield, null, 2));
        return targetMetafield;
      }

      console.log(`No metafield found with namespace '${namespace}' and key '${key}' for customer ${customerId}`);
      return null;
    } catch (error) {
      if (error.response && error.response.status === 404) {
        console.warn(`Customer with ID ${customerId} not found.`);
        throw new Error(`Customer ${customerId} not found`);
      }
      console.error('Error fetching customer metafield by namespace/key:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Create customer metafield by namespace and key (generic version)
   */
  async createCustomerMetafieldByNamespaceKey(customerId, namespace, key, value, type = 'json') {
    try {
      console.log('Creating metafield for customer:', customerId, 'namespace:', namespace, 'key:', key);

      const metafieldData = {
        namespace: namespace,
        key: key,
        type: type,
        value: JSON.stringify(value),
      };

      const response = await this.client.post({
        path: `customers/${customerId}/metafields.json`,
        data: {
          metafield: metafieldData,
        },
      });

      console.log('Create metafield response:', JSON.stringify(response.body, null, 2));
      return response.body.metafield;
    } catch (error) {
      console.error('Error creating customer metafield by namespace/key:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });
      throw error;
    }
  }

  /**
   * Update metafield by ID (generic version)
   */
  async updateMetafield(customerId, metafieldId, value) {
    try {
      console.log('Updating metafield:', metafieldId, 'for customer:', customerId);

      // Try direct update first
      try {
        const response = await this.client.put({
          path: `metafields/${metafieldId}.json`,
          data: {
            metafield: {
              value: JSON.stringify(value),
            },
          },
        });
        console.log('Update metafield response (direct):', JSON.stringify(response.body, null, 2));
        return response.body.metafield;
      } catch (directError) {
        console.log('Direct update failed, trying via customer endpoint...');
        // If direct update fails, use customer endpoint
        const response = await this.client.put({
          path: `customers/${customerId}/metafields/${metafieldId}.json`,
          data: {
            metafield: {
              value: JSON.stringify(value),
            },
          },
        });
        console.log('Update metafield response (via customer):', JSON.stringify(response.body, null, 2));
        return response.body.metafield;
      }
    } catch (error) {
      console.error('Error updating metafield:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });
      throw error;
    }
  }

  // ============================================
  // Favorites-specific methods (legacy)
  // ============================================

  async mergeFavorites(existingData, newFavoriteProductIds) {
    console.log('Merging favorites:', {
      existingData,
      newFavoriteProductIds
    });

    const mergedData = existingData || {
      saved: {},
      viewed: '',
      custom: {},
    };

    if (!mergedData.saved || typeof mergedData.saved !== 'object') {
      mergedData.saved = {};
    }

    // Use Promise.all to fetch variant IDs concurrently
    const productVariantPairs = await Promise.all(
      newFavoriteProductIds.map(async (productId) => {
        const variantId = await this.getFirstVariantId(productId);
        return { productId: String(productId), variantId }; // Ensure productId is string
      })
    );

    productVariantPairs.forEach(({ productId, variantId }) => {
      // Only proceed if a variant ID was found
      if (variantId !== null) {
        const variantIdStr = String(variantId); // Ensure variant ID is string
        
        if (!mergedData.saved[productId]) {
          // If product is new, add it with the fetched variant ID
          mergedData.saved[productId] = [variantIdStr];
        } else {
          // If product exists, add variant ID only if it's not already there
          if (!mergedData.saved[productId].includes(variantIdStr)) {
            mergedData.saved[productId].push(variantIdStr);
          }
        }
      } else {
         // If product ID or variant wasn't found, ensure the product key exists with an empty array
         // This handles cases where a product might be deleted or unavailable but was favorited
         if (!mergedData.saved[productId]) {
            mergedData.saved[productId] = [];
         }
      }
    });

    console.log('Merged result:', mergedData);
    return mergedData;
  }
}

module.exports = new ShopifyService(); 