/**
 * Discount Service
 * Handles creation of Shopify discount codes for loyalty redemption
 */

const shopify = require('../config/shopifyClient');

class DiscountService {
  constructor() {
    const shop = process.env.SHOPIFY_SHOP.replace(/^https?:\/\//, '').replace(/\/$/, '');

    this.client = new shopify.clients.Rest({
      session: {
        shop,
        accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
      },
    });
  }

  /**
   * Generate a unique discount code
   */
  generateDiscountCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Removed confusing chars (0,O,1,I)
    let code = 'LOYALTY-';
    for (let i = 0; i < 6; i++) {
      code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
  }

  /**
   * Create a one-time use loyalty discount code
   * @param {number} discountAmount - Discount value in store currency
   * @param {string} customerId - Customer ID for tracking
   * @returns {string|null} The discount code or null on failure
   */
  async createLoyaltyDiscount(discountAmount, customerId) {
    const code = this.generateDiscountCode();

    try {
      // First, create a price rule
      const priceRuleResponse = await this.client.post({
        path: 'price_rules.json',
        data: {
          price_rule: {
            title: `Loyalty Reward - Customer ${customerId}`,
            target_type: 'line_item',
            target_selection: 'all',
            allocation_method: 'across',
            value_type: 'fixed_amount',
            value: `-${discountAmount}`, // Negative value for discount
            customer_selection: 'all', // Could restrict to specific customer
            once_per_customer: true,
            usage_limit: 1,
            starts_at: new Date().toISOString(),
            ends_at: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(), // 90 days validity
          },
        },
      });

      const priceRuleId = priceRuleResponse.body.price_rule.id;
      console.log('Created price rule:', priceRuleId);

      // Then, create a discount code for that price rule
      const discountCodeResponse = await this.client.post({
        path: `price_rules/${priceRuleId}/discount_codes.json`,
        data: {
          discount_code: {
            code: code,
          },
        },
      });

      console.log('Created discount code:', code, 'for price rule:', priceRuleId);

      return code;
    } catch (error) {
      console.error('Error creating loyalty discount:', {
        message: error.message,
        response: error.response?.body,
        status: error.response?.status,
      });

      // If discount code already exists (rare), try again with a new code
      if (error.response?.body?.errors?.code) {
        console.log('Discount code collision, retrying with new code');
        return this.createLoyaltyDiscount(discountAmount, customerId);
      }

      return null;
    }
  }

  /**
   * Verify a discount code exists and is valid
   * @param {string} code - The discount code to verify
   * @returns {object|null} Discount info or null if not found/invalid
   */
  async verifyDiscountCode(code) {
    try {
      // Search for the discount code
      const response = await this.client.get({
        path: 'discount_codes/lookup.json',
        query: { code: code },
      });

      if (response.body.discount_code) {
        const discountCode = response.body.discount_code;

        // Get the associated price rule for full details
        const priceRuleResponse = await this.client.get({
          path: `price_rules/${discountCode.price_rule_id}.json`,
        });

        const priceRule = priceRuleResponse.body.price_rule;

        return {
          code: discountCode.code,
          usage_count: discountCode.usage_count,
          value: Math.abs(parseFloat(priceRule.value)),
          value_type: priceRule.value_type,
          ends_at: priceRule.ends_at,
          is_valid: discountCode.usage_count < (priceRule.usage_limit || 1),
        };
      }

      return null;
    } catch (error) {
      console.error('Error verifying discount code:', error.message);
      return null;
    }
  }
}

module.exports = new DiscountService();
