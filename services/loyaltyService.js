/**
 * Loyalty Service
 * Handles tier calculation, points math, and loyalty metafield operations
 */

const DEFAULT_CONFIG = {
  tiers: {
    bronze: { min_spend: 0, points_per_dollar: 1 },
    silver: { min_spend: 500, points_per_dollar: 1.5 },
    gold: { min_spend: 2000, points_per_dollar: 2 }
  },
  redemption: {
    points_required: 100,
    discount_value: 5,
    discount_type: 'fixed_amount'
  },
  welcome_bonus: 50
};

const LOYALTY_NAMESPACE = 'custom';
const LOYALTY_KEY = 'loyalty';
const CONFIG_NAMESPACE = 'custom';
const CONFIG_KEY = 'loyalty_config';
const MAX_HISTORY_ENTRIES = 20;

class LoyaltyService {
  constructor(shopifyService) {
    this.shopifyService = shopifyService;
  }

  /**
   * Get shop loyalty configuration from metafield or return defaults
   */
  async getConfig() {
    try {
      const config = await this.shopifyService.getShopMetafield(CONFIG_NAMESPACE, CONFIG_KEY);
      if (config && config.value) {
        const parsed = JSON.parse(config.value);
        return { ...DEFAULT_CONFIG, ...parsed };
      }
    } catch (error) {
      console.error('Error fetching loyalty config, using defaults:', error.message);
    }
    return DEFAULT_CONFIG;
  }

  /**
   * Determine customer tier based on lifetime spend
   */
  getTierFromSpend(lifetimeSpend, config) {
    const tiers = config.tiers;
    const tierNames = Object.keys(tiers).sort((a, b) => tiers[b].min_spend - tiers[a].min_spend);

    for (const tierName of tierNames) {
      if (lifetimeSpend >= tiers[tierName].min_spend) {
        return tierName;
      }
    }

    return tierNames[tierNames.length - 1]; // Return lowest tier as fallback
  }

  /**
   * Get next tier info for progress display
   */
  getNextTierInfo(currentTier, lifetimeSpend, config) {
    const tiers = config.tiers;
    const tierNames = Object.keys(tiers).sort((a, b) => tiers[a].min_spend - tiers[b].min_spend);
    const currentIndex = tierNames.indexOf(currentTier);

    if (currentIndex === tierNames.length - 1) {
      return { next_tier: null, spend_to_next_tier: 0 };
    }

    const nextTierName = tierNames[currentIndex + 1];
    const nextTierMinSpend = tiers[nextTierName].min_spend;

    return {
      next_tier: nextTierName,
      spend_to_next_tier: Math.max(0, nextTierMinSpend - lifetimeSpend)
    };
  }

  /**
   * Calculate points earned for an order amount based on tier
   */
  calculatePointsForOrder(orderTotal, tier, config) {
    const tierConfig = config.tiers[tier];
    if (!tierConfig) {
      console.warn(`Unknown tier "${tier}", using bronze rate`);
      return Math.floor(orderTotal * config.tiers.bronze.points_per_dollar);
    }
    return Math.floor(orderTotal * tierConfig.points_per_dollar);
  }

  /**
   * Get customer loyalty data from metafield
   */
  async getCustomerLoyalty(customerId) {
    try {
      const metafield = await this.shopifyService.getCustomerMetafieldByNamespaceKey(
        customerId,
        LOYALTY_NAMESPACE,
        LOYALTY_KEY
      );

      if (metafield && metafield.value) {
        return {
          metafieldId: metafield.id,
          data: JSON.parse(metafield.value)
        };
      }
    } catch (error) {
      if (!error.message.includes('not found')) {
        console.error('Error fetching customer loyalty:', error.message);
      }
    }

    return {
      metafieldId: null,
      data: null
    };
  }

  /**
   * Create initial loyalty data for new customer
   */
  createInitialLoyaltyData(welcomeBonus = 0) {
    const now = new Date().toISOString();
    const data = {
      points_balance: welcomeBonus,
      lifetime_spend: 0,
      tier: 'bronze',
      history: []
    };

    if (welcomeBonus > 0) {
      data.history.push({
        type: 'bonus',
        points: welcomeBonus,
        reason: 'welcome',
        date: now
      });
    }

    return data;
  }

  /**
   * Add entry to history, keeping only last N entries
   */
  addToHistory(history, entry) {
    const newHistory = [entry, ...history];
    return newHistory.slice(0, MAX_HISTORY_ENTRIES);
  }

  /**
   * Award points to customer for an order
   */
  async awardPoints(customerId, orderId, orderTotal) {
    const config = await this.getConfig();
    let { metafieldId, data } = await this.getCustomerLoyalty(customerId);

    // Initialize if new customer
    if (!data) {
      data = this.createInitialLoyaltyData(config.welcome_bonus);
    }

    // Check for duplicate (order already processed)
    const existingEntry = data.history.find(
      h => h.type === 'earn' && h.order_id === String(orderId)
    );
    if (existingEntry) {
      console.log(`Order ${orderId} already processed for customer ${customerId}, skipping`);
      return { success: true, duplicate: true, points_awarded: 0 };
    }

    // Calculate new lifetime spend and tier
    const newLifetimeSpend = data.lifetime_spend + orderTotal;
    const newTier = this.getTierFromSpend(newLifetimeSpend, config);

    // Calculate points based on NEW tier (reward for upgrading)
    const pointsEarned = this.calculatePointsForOrder(orderTotal, newTier, config);

    // Update data
    data.lifetime_spend = newLifetimeSpend;
    data.tier = newTier;
    data.points_balance += pointsEarned;
    data.history = this.addToHistory(data.history, {
      type: 'earn',
      points: pointsEarned,
      order_id: String(orderId),
      order_total: orderTotal,
      tier_at_purchase: newTier,
      date: new Date().toISOString()
    });

    // Save to metafield
    if (metafieldId) {
      await this.shopifyService.updateMetafield(customerId, metafieldId, data);
    } else {
      await this.shopifyService.createCustomerMetafieldByNamespaceKey(
        customerId,
        LOYALTY_NAMESPACE,
        LOYALTY_KEY,
        data,
        'json'
      );
    }

    console.log(`Awarded ${pointsEarned} points to customer ${customerId} for order ${orderId}`);

    return {
      success: true,
      duplicate: false,
      points_awarded: pointsEarned,
      new_balance: data.points_balance,
      tier: newTier
    };
  }

  /**
   * Reverse points for a refund
   */
  async reversePoints(customerId, orderId, refundAmount) {
    const config = await this.getConfig();
    const { metafieldId, data } = await this.getCustomerLoyalty(customerId);

    if (!data || !metafieldId) {
      console.warn(`No loyalty data for customer ${customerId}, cannot reverse points`);
      return { success: false, reason: 'no_loyalty_data' };
    }

    // Find original order in history to get tier rate
    const originalEntry = data.history.find(
      h => h.type === 'earn' && h.order_id === String(orderId)
    );

    let pointsToDeduct;
    if (originalEntry && originalEntry.tier_at_purchase) {
      // Use the tier rate from the original purchase
      pointsToDeduct = this.calculatePointsForOrder(
        refundAmount,
        originalEntry.tier_at_purchase,
        config
      );
    } else {
      // Fallback: use current tier rate
      pointsToDeduct = this.calculatePointsForOrder(refundAmount, data.tier, config);
    }

    // Deduct points (minimum 0)
    const actualDeduction = Math.min(pointsToDeduct, data.points_balance);
    data.points_balance = Math.max(0, data.points_balance - pointsToDeduct);

    // Add reversal to history
    data.history = this.addToHistory(data.history, {
      type: 'reverse',
      points: -actualDeduction,
      order_id: String(orderId),
      refund_amount: refundAmount,
      reason: 'refund',
      date: new Date().toISOString()
    });

    // Save to metafield
    await this.shopifyService.updateMetafield(customerId, metafieldId, data);

    console.log(`Reversed ${actualDeduction} points for customer ${customerId} (refund on order ${orderId})`);

    return {
      success: true,
      points_deducted: actualDeduction,
      new_balance: data.points_balance
    };
  }

  /**
   * Redeem points for a discount code
   */
  async redeemPoints(customerId, pointsToRedeem, discountService) {
    const config = await this.getConfig();
    const { metafieldId, data } = await this.getCustomerLoyalty(customerId);

    if (!data || !metafieldId) {
      return { success: false, error: 'No loyalty account found' };
    }

    // Validate redemption
    const { points_required, discount_value } = config.redemption;

    if (pointsToRedeem < points_required) {
      return {
        success: false,
        error: `Minimum ${points_required} points required for redemption`
      };
    }

    if (pointsToRedeem > data.points_balance) {
      return {
        success: false,
        error: `Insufficient points. You have ${data.points_balance} points.`
      };
    }

    // Calculate discount value (multiples of redemption unit)
    const redemptionUnits = Math.floor(pointsToRedeem / points_required);
    const actualPointsUsed = redemptionUnits * points_required;
    const discountAmount = redemptionUnits * discount_value;

    // Create discount code via Shopify
    const discountCode = await discountService.createLoyaltyDiscount(
      discountAmount,
      customerId
    );

    if (!discountCode) {
      return { success: false, error: 'Failed to create discount code' };
    }

    // Deduct points
    data.points_balance -= actualPointsUsed;

    // Add to history
    data.history = this.addToHistory(data.history, {
      type: 'redeem',
      points: -actualPointsUsed,
      discount_code: discountCode,
      discount_value: discountAmount,
      date: new Date().toISOString()
    });

    // Save to metafield
    await this.shopifyService.updateMetafield(customerId, metafieldId, data);

    console.log(`Customer ${customerId} redeemed ${actualPointsUsed} points for $${discountAmount} discount`);

    return {
      success: true,
      discount_code: discountCode,
      discount_value: discountAmount,
      points_redeemed: actualPointsUsed,
      remaining_points: data.points_balance
    };
  }

  /**
   * Get full loyalty status for display
   */
  async getLoyaltyStatus(customerId) {
    const config = await this.getConfig();
    const { data } = await this.getCustomerLoyalty(customerId);

    if (!data) {
      // Return empty status for customers without loyalty data
      return {
        points_balance: 0,
        lifetime_spend: 0,
        tier: 'bronze',
        tier_config: config.tiers.bronze,
        next_tier: 'silver',
        spend_to_next_tier: config.tiers.silver.min_spend,
        redemption: config.redemption,
        history: []
      };
    }

    const nextTierInfo = this.getNextTierInfo(data.tier, data.lifetime_spend, config);

    return {
      points_balance: data.points_balance,
      lifetime_spend: data.lifetime_spend,
      tier: data.tier,
      tier_config: config.tiers[data.tier],
      ...nextTierInfo,
      redemption: config.redemption,
      history: data.history || []
    };
  }
}

module.exports = LoyaltyService;
