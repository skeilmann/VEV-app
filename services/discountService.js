/**
 * Discount Service
 * Creates one-time loyalty discount codes with the Admin GraphQL API
 * (discountCodeBasicCreate, scope write_discounts).
 *
 * Each code: fixed amount off the order, only for the customer who redeemed
 * the points, single use, valid 90 days.
 */

const crypto = require('crypto');

const API_VERSION = '2026-01';
const VALID_DAYS = 90;
const MAX_ATTEMPTS = 3;

const MUTATION = `
  mutation LoyaltyDiscount($discount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $discount) {
      codeDiscountNode { id }
      userErrors { field code message }
    }
  }
`;

class DiscountService {
  constructor({ fetchImpl = (...args) => fetch(...args), env = process.env } = {}) {
    this.fetch = fetchImpl;
    this.env = env;
  }

  get endpoint() {
    const shop = (this.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${shop}/admin/api/${API_VERSION}/graphql.json`;
  }

  generateDiscountCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
    let code = 'LOYALTY-';
    for (let i = 0; i < 8; i++) {
      code += chars.charAt(crypto.randomInt(chars.length));
    }
    return code;
  }

  buildInput(code, discountAmount, customerId, now = new Date()) {
    return {
      title: `Loyalty reward ${code}`,
      code,
      startsAt: now.toISOString(),
      endsAt: new Date(now.getTime() + VALID_DAYS * 24 * 60 * 60 * 1000).toISOString(),
      context: { customers: { add: [`gid://shopify/Customer/${customerId}`] } },
      customerGets: {
        value: { discountAmount: { amount: Number(discountAmount).toFixed(2), appliesOnEachItem: false } },
        items: { all: true },
      },
      appliesOncePerCustomer: true,
      usageLimit: 1,
    };
  }

  /**
   * @returns {Promise<string|null>} the code, or null when it could not be created
   */
  async createLoyaltyDiscount(discountAmount, customerId) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const code = this.generateDiscountCode();
      let body;
      try {
        const response = await this.fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': this.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
          },
          body: JSON.stringify({ query: MUTATION, variables: { discount: this.buildInput(code, discountAmount, customerId) } }),
        });
        body = await response.json().catch(() => ({}));
        if (!response.ok) {
          console.error('Discount creation failed: HTTP', response.status, String(body.errors || '').slice(0, 200));
          return null;
        }
      } catch (error) {
        console.error('Discount creation failed:', error.message);
        return null;
      }

      if (body.errors) {
        console.error('Discount creation GraphQL errors:', JSON.stringify(body.errors).slice(0, 300));
        return null;
      }

      const result = body.data && body.data.discountCodeBasicCreate;
      const userErrors = (result && result.userErrors) || [];
      if (result && result.codeDiscountNode && userErrors.length === 0) {
        console.log('Created loyalty discount for customer', customerId, result.codeDiscountNode.id);
        return code;
      }

      const codeTaken = userErrors.some((e) => (e.field || []).includes('code'));
      console.error('Discount creation user errors:', JSON.stringify(userErrors).slice(0, 300));
      if (!codeTaken) return null;
      console.log('Discount code collision, retrying with a new code');
    }
    return null;
  }
}

module.exports = new DiscountService();
module.exports.DiscountService = DiscountService;
