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

  mergeFavorites(existingData, newFavorites) {
    console.log('Merging favorites:', {
      existingData,
      newFavorites
    });
    
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

    console.log('Merged result:', mergedData);
    return mergedData;
  }
}

module.exports = new ShopifyService(); 