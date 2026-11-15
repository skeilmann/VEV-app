/**
 * Loyalty Service
 * Tier calculation, points math and the customer loyalty metafield.
 *
 * Customer metafield custom.loyalty (json):
 * {
 *   points_balance: number   // may go negative after a refund (a debt that blocks redemption)
 *   lifetime_spend: number   // shop currency, 2 decimals; lowered by refunds
 *   tier: "bronze" | "silver" | "gold"
 *   history: [...]           // last 20 entries, for display only
 *   orders: { "<orderId>": { total, earned, refunded, reversed, tier } }  // not capped
 *   refund_ids: ["<refundId>", ...]                                        // not capped
 * }
 * Duplicate webhooks are detected with `orders` / `refund_ids`, never with
 * the capped history.
 *
 * Every change to a balance runs inside a per-customer lock.
 */

const { withCustomerLock } = require('../lib/customerLock');

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
const CONFIG_CACHE_MS = 60 * 1000;

const round2 = (n) => Math.round(n * 100) / 100;
const isNonNegativeNumber = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;

/**
 * Merge a stored config over the defaults (per tier / per field) and check it.
 * Throws on an invalid config instead of letting NaN reach the points math.
 */
function buildConfig(stored) {
  const tiers = {};
  const storedTiers = (stored && stored.tiers) || {};
  const tierNames = new Set([...Object.keys(DEFAULT_CONFIG.tiers), ...Object.keys(storedTiers)]);
  for (const name of tierNames) {
    tiers[name] = { ...(DEFAULT_CONFIG.tiers[name] || {}), ...(storedTiers[name] || {}) };
  }
  const config = {
    tiers,
    redemption: { ...DEFAULT_CONFIG.redemption, ...((stored && stored.redemption) || {}) },
    welcome_bonus: stored && stored.welcome_bonus !== undefined ? stored.welcome_bonus : DEFAULT_CONFIG.welcome_bonus
  };

  for (const [name, tier] of Object.entries(config.tiers)) {
    if (!isNonNegativeNumber(tier.min_spend) || !isNonNegativeNumber(tier.points_per_dollar)) {
      throw new Error(`Invalid loyalty config for tier "${name}"`);
    }
  }
  if (!config.tiers.bronze || config.tiers.bronze.min_spend !== 0) {
    throw new Error('Invalid loyalty config: tier "bronze" with min_spend 0 is required');
  }
  const { points_required, discount_value } = config.redemption;
  if (!Number.isInteger(points_required) || points_required <= 0 || !isNonNegativeNumber(discount_value) || discount_value <= 0) {
    throw new Error('Invalid loyalty config: redemption');
  }
  if (!Number.isInteger(config.welcome_bonus) || config.welcome_bonus < 0) {
    throw new Error('Invalid loyalty config: welcome_bonus');
  }
  return config;
}

class LoyaltyService {
  constructor(shopifyService) {
    this.shopifyService = shopifyService;
    this.configCache = null;
  }

  /**
   * Shop loyalty configuration (shop metafield custom.loyalty_config merged
   * over the defaults), cached for 60s. A failed read throws: using the
   * defaults by accident would apply the wrong exchange rate.
   */
  async getConfig() {
    if (this.configCache && Date.now() - this.configCache.at < CONFIG_CACHE_MS) {
      return this.configCache.config;
    }
    const metafield = await this.shopifyService.getShopMetafield(CONFIG_NAMESPACE, CONFIG_KEY);
    const stored = metafield && metafield.value ? JSON.parse(metafield.value) : null;
    const config = buildConfig(stored);
    this.configCache = { at: Date.now(), config };
    return config;
  }

  getTierFromSpend(lifetimeSpend, config) {
    const tiers = config.tiers;
    const tierNames = Object.keys(tiers).sort((a, b) => tiers[b].min_spend - tiers[a].min_spend);
    for (const tierName of tierNames) {
      if (lifetimeSpend >= tiers[tierName].min_spend) return tierName;
    }
    return 'bronze';
  }

  getNextTierInfo(currentTier, lifetimeSpend, config) {
    const tiers = config.tiers;
    const tierNames = Object.keys(tiers).sort((a, b) => tiers[a].min_spend - tiers[b].min_spend);
    const currentIndex = tierNames.indexOf(currentTier);

    if (currentIndex === -1 || currentIndex === tierNames.length - 1) {
      return { next_tier: null, spend_to_next_tier: 0 };
    }

    const nextTierName = tierNames[currentIndex + 1];
    return {
      next_tier: nextTierName,
      spend_to_next_tier: round2(Math.max(0, tiers[nextTierName].min_spend - lifetimeSpend))
    };
  }

  calculatePointsForOrder(orderTotal, tier, config) {
    const tierConfig = config.tiers[tier] || config.tiers.bronze;
    return Math.floor(round2(orderTotal * tierConfig.points_per_dollar));
  }

  /**
   * Read the customer's loyalty metafield. "Customer not found" means no data;
   * any other failure throws, so callers never overwrite a real balance with a
   * fresh one after a temporary Shopify error.
   */
  async getCustomerLoyalty(customerId) {
    try {
      const metafield = await this.shopifyService.getCustomerMetafieldByNamespaceKey(
        customerId,
        LOYALTY_NAMESPACE,
        LOYALTY_KEY
      );
      if (metafield && metafield.value) {
        return { metafieldId: metafield.id, data: this.upgradeData(JSON.parse(metafield.value)) };
      }
    } catch (error) {
      if (!error.message.includes('not found')) {
        console.error('Error fetching customer loyalty:', error.message);
        throw error;
      }
    }
    return { metafieldId: null, data: null };
  }

  /**
   * Older records had no `orders` / `refund_ids`: rebuild them from history so
   * duplicate detection keeps working for orders recorded before this change.
   */
  upgradeData(data) {
    data.history = Array.isArray(data.history) ? data.history : [];
    data.refund_ids = Array.isArray(data.refund_ids) ? data.refund_ids : [];
    if (!data.orders || typeof data.orders !== 'object') {
      data.orders = {};
      for (const entry of [...data.history].reverse()) {
        if (entry.type === 'earn' && entry.order_id && !data.orders[entry.order_id]) {
          data.orders[entry.order_id] = {
            total: entry.order_total || 0,
            earned: entry.points || 0,
            refunded: 0,
            reversed: 0,
            tier: entry.tier_at_purchase || 'bronze'
          };
        }
        if (entry.type === 'reverse' && entry.order_id && data.orders[entry.order_id]) {
          const order = data.orders[entry.order_id];
          order.reversed += Math.abs(entry.points || 0);
          order.refunded = round2(order.refunded + (entry.refund_amount || 0));
        }
      }
    }
    return data;
  }

  createInitialLoyaltyData(welcomeBonus = 0) {
    const data = {
      points_balance: welcomeBonus,
      lifetime_spend: 0,
      tier: 'bronze',
      history: [],
      orders: {},
      refund_ids: []
    };
    if (welcomeBonus > 0) {
      data.history.push({ type: 'bonus', points: welcomeBonus, reason: 'welcome', date: new Date().toISOString() });
    }
    return data;
  }

  addToHistory(history, entry) {
    return [entry, ...history].slice(0, MAX_HISTORY_ENTRIES);
  }

  async save(customerId, metafieldId, data) {
    if (metafieldId) {
      await this.shopifyService.updateMetafield(customerId, metafieldId, data);
    } else {
      await this.shopifyService.createCustomerMetafieldByNamespaceKey(customerId, LOYALTY_NAMESPACE, LOYALTY_KEY, data, 'json');
    }
  }

  // ------------------------------------------------------------------ award

  awardPoints(customerId, orderId, orderTotal) {
    return withCustomerLock(customerId, () => this._awardPoints(customerId, orderId, orderTotal));
  }

  async _awardPoints(customerId, orderId, orderTotal) {
    const config = await this.getConfig();
    let { metafieldId, data } = await this.getCustomerLoyalty(customerId);
    if (!data) data = this.createInitialLoyaltyData(config.welcome_bonus);

    const key = String(orderId);
    if (data.orders[key]) {
      console.log(`Order ${key} already processed for customer ${customerId}, skipping`);
      return { success: true, duplicate: true, points_awarded: 0 };
    }

    const total = round2(orderTotal);
    data.lifetime_spend = round2(data.lifetime_spend + total);
    const newTier = this.getTierFromSpend(data.lifetime_spend, config);
    // Points use the tier reached with this order (reward for upgrading)
    const pointsEarned = this.calculatePointsForOrder(total, newTier, config);

    data.tier = newTier;
    data.points_balance += pointsEarned;
    data.orders[key] = { total, earned: pointsEarned, refunded: 0, reversed: 0, tier: newTier };
    data.history = this.addToHistory(data.history, {
      type: 'earn',
      points: pointsEarned,
      order_id: key,
      order_total: total,
      tier_at_purchase: newTier,
      date: new Date().toISOString()
    });

    await this.save(customerId, metafieldId, data);
    console.log(`Awarded ${pointsEarned} points to customer ${customerId} for order ${key}`);

    return { success: true, duplicate: false, points_awarded: pointsEarned, new_balance: data.points_balance, tier: newTier };
  }

  // ------------------------------------------------------------------ refund

  reversePoints(customerId, orderId, refundAmount, refundId) {
    return withCustomerLock(customerId, () => this._reversePoints(customerId, orderId, refundAmount, refundId));
  }

  /**
   * Takes back points in proportion to the money refunded, never more than the
   * order earned. The balance may go negative (points already spent on a code);
   * that debt blocks redemption until new orders cover it. Lifetime spend and
   * tier are lowered as well.
   */
  async _reversePoints(customerId, orderId, refundAmount, refundId) {
    const config = await this.getConfig();
    const { metafieldId, data } = await this.getCustomerLoyalty(customerId);

    if (!data || !metafieldId) {
      console.warn(`No loyalty data for customer ${customerId}, nothing to reverse`);
      return { success: false, reason: 'no_loyalty_data' };
    }

    const refundKey = refundId != null ? String(refundId) : null;
    if (refundKey && data.refund_ids.includes(refundKey)) {
      console.log(`Refund ${refundKey} already processed for customer ${customerId}, skipping`);
      return { success: true, duplicate: true, points_deducted: 0, new_balance: data.points_balance };
    }

    const order = data.orders[String(orderId)];
    if (refundKey) data.refund_ids.push(refundKey);

    if (!order) {
      // Order earned no points here (paid before launch, guest, etc.)
      await this.save(customerId, metafieldId, data);
      console.log(`Order ${orderId} earned no points for customer ${customerId}; refund recorded, nothing deducted`);
      return { success: true, skipped: true, points_deducted: 0, new_balance: data.points_balance };
    }

    const amount = round2(refundAmount);
    order.refunded = round2(order.refunded + amount);
    const share = order.total > 0 ? Math.min(1, order.refunded / order.total) : 1;
    const shouldBeReversed = Math.min(order.earned, Math.round(order.earned * share));
    const deduction = Math.max(0, shouldBeReversed - order.reversed);
    order.reversed += deduction;

    data.points_balance -= deduction;
    data.lifetime_spend = round2(Math.max(0, data.lifetime_spend - amount));
    data.tier = this.getTierFromSpend(data.lifetime_spend, config);
    data.history = this.addToHistory(data.history, {
      type: 'reverse',
      points: -deduction,
      order_id: String(orderId),
      refund_id: refundKey || undefined,
      refund_amount: amount,
      reason: 'refund',
      date: new Date().toISOString()
    });

    await this.save(customerId, metafieldId, data);
    console.log(`Reversed ${deduction} points for customer ${customerId} (refund on order ${orderId})`);

    return { success: true, points_deducted: deduction, new_balance: data.points_balance, tier: data.tier };
  }

  // ------------------------------------------------------------------ redeem

  redeemPoints(customerId, pointsToRedeem, discountService) {
    return withCustomerLock(customerId, () => this._redeemPoints(customerId, pointsToRedeem, discountService));
  }

  /**
   * Points are deducted and saved BEFORE the discount code is created, so a
   * failure can never hand out a code without spending points. If creating the
   * code fails, the points are given back.
   */
  async _redeemPoints(customerId, pointsToRedeem, discountService) {
    const config = await this.getConfig();
    const { metafieldId, data } = await this.getCustomerLoyalty(customerId);

    if (!data || !metafieldId) {
      return { success: false, error: 'No loyalty account found' };
    }

    const { points_required, discount_value } = config.redemption;

    if (!Number.isInteger(pointsToRedeem) || pointsToRedeem < points_required) {
      return { success: false, error: `Minimum ${points_required} points required for redemption` };
    }
    if (pointsToRedeem > data.points_balance) {
      return { success: false, error: 'Insufficient points' };
    }

    const redemptionUnits = Math.floor(pointsToRedeem / points_required);
    const actualPointsUsed = redemptionUnits * points_required;
    const discountAmount = round2(redemptionUnits * discount_value);
    const balanceBefore = data.points_balance;
    const historyBefore = data.history;

    // 1. Spend the points
    data.points_balance = balanceBefore - actualPointsUsed;
    data.history = this.addToHistory(historyBefore, {
      type: 'redeem',
      points: -actualPointsUsed,
      discount_value: discountAmount,
      date: new Date().toISOString()
    });
    await this.shopifyService.updateMetafield(customerId, metafieldId, data);

    // 2. Create the code (restricted to this customer)
    let discountCode = null;
    try {
      discountCode = await discountService.createLoyaltyDiscount(discountAmount, customerId);
    } catch (error) {
      console.error('Discount creation threw:', error.message);
    }

    if (!discountCode) {
      // 3a. Give the points back
      data.points_balance = balanceBefore;
      data.history = historyBefore;
      try {
        await this.shopifyService.updateMetafield(customerId, metafieldId, data);
      } catch (restoreError) {
        console.error(
          `CRITICAL: could not restore ${actualPointsUsed} points for customer ${customerId}:`,
          restoreError.message
        );
      }
      return { success: false, error: 'Failed to create discount code' };
    }

    // 3b. Record the code in history (best effort: the points are already spent)
    data.history[0].discount_code = discountCode;
    try {
      await this.shopifyService.updateMetafield(customerId, metafieldId, data);
    } catch (error) {
      console.error(`Could not record discount code in history for customer ${customerId}:`, error.message);
    }

    console.log(`Customer ${customerId} redeemed ${actualPointsUsed} points for a ${discountAmount} discount`);

    return {
      success: true,
      discount_code: discountCode,
      discount_value: discountAmount,
      points_redeemed: actualPointsUsed,
      remaining_points: data.points_balance
    };
  }

  // ------------------------------------------------------------------ status

  async getLoyaltyStatus(customerId) {
    const config = await this.getConfig();
    const { data } = await this.getCustomerLoyalty(customerId);

    if (!data) {
      const next = this.getNextTierInfo('bronze', 0, config);
      return {
        points_balance: 0,
        lifetime_spend: 0,
        tier: 'bronze',
        tier_config: config.tiers.bronze,
        ...next,
        redemption: config.redemption,
        history: []
      };
    }

    return {
      points_balance: data.points_balance,
      lifetime_spend: data.lifetime_spend,
      tier: data.tier,
      tier_config: config.tiers[data.tier] || config.tiers.bronze,
      ...this.getNextTierInfo(data.tier, data.lifetime_spend, config),
      redemption: config.redemption,
      history: data.history
    };
  }
}

module.exports = LoyaltyService;
module.exports.buildConfig = buildConfig;
