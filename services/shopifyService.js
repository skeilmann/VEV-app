/**
 * Shopify Admin REST helpers used by the app.
 * Logs IDs only — never metafield values (they hold balances and discount codes).
 */

const shopify = require('../config/shopifyClient');

/** HTTP status of a @shopify/shopify-api error (v7 uses response.code). */
function httpStatus(error) {
  return error?.response?.code ?? error?.response?.status;
}

function errorInfo(error) {
  return { message: error.message.split('\n')[0], status: httpStatus(error) };
}

class ShopifyService {
  constructor() {
    const shop = (process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    this.client = new shopify.clients.Rest({
      session: {
        shop,
        accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
    });
  }

  /** Shop-level metafield, or null when it does not exist. */
  async getShopMetafield(namespace, key) {
    try {
      const response = await this.client.get({
        path: 'metafields.json',
        query: { namespace, key },
      });
      const metafields = response.body.metafields || [];
      return metafields.find((mf) => mf.namespace === namespace && mf.key === key) || null;
    } catch (error) {
      console.error('Error fetching shop metafield', namespace, key, errorInfo(error));
      throw error;
    }
  }

  /**
   * One customer metafield, or null. Filters by namespace/key on Shopify's side,
   * so customers with many metafields are not cut off by paging.
   * Throws Error("Customer <id> not found") on 404.
   */
  async getCustomerMetafieldByNamespaceKey(customerId, namespace, key) {
    try {
      const response = await this.client.get({
        path: `customers/${customerId}/metafields.json`,
        query: { namespace, key },
      });
      const metafields = response.body.metafields || [];
      return metafields.find((mf) => mf.namespace === namespace && mf.key === key) || null;
    } catch (error) {
      if (httpStatus(error) === 404) {
        throw new Error(`Customer ${customerId} not found`);
      }
      console.error('Error fetching customer metafield', customerId, namespace, key, errorInfo(error));
      throw error;
    }
  }

  async createCustomerMetafieldByNamespaceKey(customerId, namespace, key, value, type = 'json') {
    try {
      const response = await this.client.post({
        path: `customers/${customerId}/metafields.json`,
        data: { metafield: { namespace, key, type, value: JSON.stringify(value) } },
      });
      return response.body.metafield;
    } catch (error) {
      console.error('Error creating customer metafield', customerId, namespace, key, errorInfo(error));
      throw error;
    }
  }

  async updateMetafield(customerId, metafieldId, value) {
    try {
      const response = await this.client.put({
        path: `customers/${customerId}/metafields/${metafieldId}.json`,
        data: { metafield: { id: metafieldId, value: JSON.stringify(value) } },
      });
      return response.body.metafield;
    } catch (error) {
      console.error('Error updating customer metafield', customerId, metafieldId, errorInfo(error));
      throw error;
    }
  }

  /** Customer ID of an order, or null for guest orders. Needs read_orders. */
  async getOrderCustomerId(orderId) {
    try {
      const response = await this.client.get({
        path: `orders/${orderId}.json`,
        query: { fields: 'id,customer' },
      });
      return response.body.order?.customer?.id || null;
    } catch (error) {
      console.error('Error fetching order', orderId, errorInfo(error));
      throw error;
    }
  }
}

module.exports = new ShopifyService();
module.exports.httpStatus = httpStatus;
