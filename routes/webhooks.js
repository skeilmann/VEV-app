/**
 * Webhook Routes
 * Handles Shopify webhooks for orders and refunds
 */

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const LoyaltyService = require('../services/loyaltyService');

// Initialize loyalty service
const loyaltyService = new LoyaltyService(shopifyService);

/**
 * Verify Shopify webhook HMAC signature
 */
function verifyWebhookSignature(req) {
  const hmacHeader = req.get('X-Shopify-Hmac-SHA256');
  if (!hmacHeader) {
    console.warn('Missing X-Shopify-Hmac-SHA256 header');
    return false;
  }

  const secret = process.env.SHOPIFY_API_SECRET || process.env.API_SECRET_KEY;
  if (!secret) {
    console.error('No API secret configured for webhook verification');
    return false;
  }

  // req.rawBody must be set by middleware before JSON parsing
  const rawBody = req.rawBody;
  if (!rawBody) {
    console.error('No raw body available for HMAC verification');
    return false;
  }

  const calculatedHmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  const valid = crypto.timingSafeEquals(
    Buffer.from(hmacHeader),
    Buffer.from(calculatedHmac)
  );

  if (!valid) {
    console.warn('Webhook HMAC verification failed');
  }

  return valid;
}

/**
 * POST /api/webhooks/orders-paid
 * Award points when an order is paid
 */
router.post('/orders-paid', async (req, res) => {
  try {
    console.log('=== WEBHOOK: ORDERS PAID ===');

    // Verify webhook signature (skip in development if needed)
    if (process.env.NODE_ENV === 'production' && !verifyWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const order = req.body;

    // Log basic order info
    console.log('Order ID:', order.id);
    console.log('Order Number:', order.order_number);
    console.log('Customer:', order.customer?.id);
    console.log('Total Price:', order.total_price);

    // Validate required fields
    if (!order.customer || !order.customer.id) {
      console.log('No customer associated with order (guest checkout), skipping loyalty points');
      return res.status(200).json({
        success: true,
        message: 'Skipped - guest checkout',
      });
    }

    const customerId = order.customer.id;
    const orderId = order.id;
    const orderTotal = parseFloat(order.total_price) || 0;

    if (orderTotal <= 0) {
      console.log('Order total is zero or negative, skipping loyalty points');
      return res.status(200).json({
        success: true,
        message: 'Skipped - zero total',
      });
    }

    // Award points
    const result = await loyaltyService.awardPoints(customerId, orderId, orderTotal);

    if (result.duplicate) {
      console.log('Order already processed, skipping');
      return res.status(200).json({
        success: true,
        message: 'Already processed',
      });
    }

    console.log('Points awarded:', result.points_awarded);
    console.log('New balance:', result.new_balance);
    console.log('Tier:', result.tier);

    res.status(200).json({
      success: true,
      points_awarded: result.points_awarded,
      new_balance: result.new_balance,
      tier: result.tier,
    });
  } catch (error) {
    console.error('Error processing orders-paid webhook:', error);

    // Always return 200 to prevent Shopify from retrying on application errors
    // Log the error for investigation
    res.status(200).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * POST /api/webhooks/refunds-create
 * Reverse points when a refund is created
 */
router.post('/refunds-create', async (req, res) => {
  try {
    console.log('=== WEBHOOK: REFUNDS CREATE ===');

    // Verify webhook signature (skip in development if needed)
    if (process.env.NODE_ENV === 'production' && !verifyWebhookSignature(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature' });
    }

    const refund = req.body;

    // Log basic refund info
    console.log('Refund ID:', refund.id);
    console.log('Order ID:', refund.order_id);

    // Get refund amount from transactions
    let refundAmount = 0;
    if (refund.transactions && Array.isArray(refund.transactions)) {
      refundAmount = refund.transactions.reduce((sum, t) => {
        return sum + (parseFloat(t.amount) || 0);
      }, 0);
    }

    console.log('Refund Amount:', refundAmount);

    if (refundAmount <= 0) {
      console.log('Refund amount is zero or negative, skipping');
      return res.status(200).json({
        success: true,
        message: 'Skipped - zero refund amount',
      });
    }

    // We need to get the order to find the customer
    // The refund webhook doesn't always include customer info
    const orderId = refund.order_id;
    if (!orderId) {
      console.log('No order ID in refund, cannot process');
      return res.status(200).json({
        success: true,
        message: 'Skipped - no order ID',
      });
    }

    // Fetch the order to get customer ID
    // Note: This requires read_orders scope
    let customerId;
    try {
      const shopify = require('../config/shopifyClient');
      const shop = process.env.SHOPIFY_SHOP.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const client = new shopify.clients.Rest({
        session: {
          shop,
          accessToken: process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN,
        },
      });

      const orderResponse = await client.get({
        path: `orders/${orderId}.json`,
        query: { fields: 'customer' },
      });

      customerId = orderResponse.body.order?.customer?.id;
    } catch (orderError) {
      console.error('Error fetching order for refund:', orderError.message);
      return res.status(200).json({
        success: true,
        message: 'Skipped - could not fetch order',
      });
    }

    if (!customerId) {
      console.log('No customer associated with order, skipping');
      return res.status(200).json({
        success: true,
        message: 'Skipped - guest checkout',
      });
    }

    // Reverse points
    const result = await loyaltyService.reversePoints(customerId, orderId, refundAmount);

    console.log('Points deducted:', result.points_deducted);
    console.log('New balance:', result.new_balance);

    res.status(200).json({
      success: true,
      points_deducted: result.points_deducted,
      new_balance: result.new_balance,
    });
  } catch (error) {
    console.error('Error processing refunds-create webhook:', error);

    // Always return 200 to prevent Shopify from retrying on application errors
    res.status(200).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/webhooks/test
 * Test endpoint to verify webhook routes are working
 */
router.get('/test', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook routes are working',
    endpoints: [
      'POST /api/webhooks/orders-paid',
      'POST /api/webhooks/refunds-create',
    ],
  });
});

module.exports = router;
