/**
 * Webhook Routes
 * Shopify webhooks orders/paid (award points) and refunds/create (take back points).
 *
 * Every request must be signed by Shopify (HMAC of the raw body) and come from
 * this shop. Processing errors return 500 so Shopify retries; duplicates are
 * skipped by order ID / refund ID in loyaltyService.
 */

const express = require('express');
const { verifyWebhookSignature } = require('../lib/webhookSignature');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const LoyaltyService = require('../services/loyaltyService');

const loyaltyService = new LoyaltyService(shopifyService);

const shopDomain = () => (process.env.SHOPIFY_SHOP || '').replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
const shopCurrency = () => (process.env.SHOP_CURRENCY || 'MDL').toUpperCase();
const money = (v) => {
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

function requireShopifyWebhook(req, res, next) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!verifyWebhookSignature(req.rawBody, req.get('X-Shopify-Hmac-SHA256'), secret)) {
    console.warn('Webhook rejected: invalid or missing HMAC signature');
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  const from = (req.get('X-Shopify-Shop-Domain') || '').toLowerCase();
  if (!shopDomain() || from !== shopDomain()) {
    console.warn('Webhook rejected: unexpected shop domain', from);
    return res.status(401).json({ error: 'Unexpected shop' });
  }
  next();
}

router.use(requireShopifyWebhook);

/**
 * Amount that earns points, in shop currency: the order total minus gift
 * cards bought in it (those earn points when they are spent instead).
 */
function earnableAmount(order) {
  const total = money(order.total_price_set?.shop_money?.amount ?? order.total_price);
  const giftCards = (order.line_items || [])
    .filter((item) => item && item.gift_card)
    .reduce((sum, item) => sum + money(item.price_set?.shop_money?.amount ?? item.price) * (item.quantity || 0), 0);
  return Math.max(0, total - giftCards);
}

router.post('/orders-paid', async (req, res) => {
  const order = req.body || {};
  try {
    const customerId = order.customer?.id;
    if (!customerId) {
      return res.status(200).json({ success: true, message: 'Skipped - guest checkout' });
    }

    const amount = earnableAmount(order);
    if (amount <= 0) {
      return res.status(200).json({ success: true, message: 'Skipped - nothing to earn' });
    }

    const result = await loyaltyService.awardPoints(customerId, order.id, amount);
    console.log(`orders/paid ${order.id}: customer ${customerId}, +${result.points_awarded}${result.duplicate ? ' (duplicate)' : ''}`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error(`orders/paid ${order.id} failed:`, error.message);
    res.status(500).json({ success: false });
  }
});

router.post('/refunds-create', async (req, res) => {
  const refund = req.body || {};
  try {
    const orderId = refund.order_id;
    if (!orderId) {
      return res.status(200).json({ success: true, message: 'Skipped - no order ID' });
    }

    // Money actually returned: successful "refund" transactions in shop currency
    let refundAmount = 0;
    for (const t of refund.transactions || []) {
      if (!t || t.kind !== 'refund' || t.status !== 'success') continue;
      if (t.currency && t.currency.toUpperCase() !== shopCurrency()) {
        console.warn(`Refund ${refund.id}: transaction in ${t.currency}, expected ${shopCurrency()}; not counted`);
        continue;
      }
      refundAmount += money(t.amount);
    }

    if (refundAmount <= 0) {
      return res.status(200).json({ success: true, message: 'Skipped - zero refund amount' });
    }

    const customerId = await shopifyService.getOrderCustomerId(orderId);
    if (!customerId) {
      return res.status(200).json({ success: true, message: 'Skipped - guest checkout' });
    }

    const result = await loyaltyService.reversePoints(customerId, orderId, refundAmount, refund.id);
    console.log(`refunds/create ${refund.id}: customer ${customerId}, -${result.points_deducted || 0}`);
    res.status(200).json({ success: true });
  } catch (error) {
    console.error(`refunds/create ${refund.id} failed:`, error.message);
    res.status(500).json({ success: false });
  }
});

module.exports = router;
module.exports.earnableAmount = earnableAmount;
