/**
 * Loyalty Routes
 * Handles loyalty balance queries and point redemption
 */

const express = require('express');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const LoyaltyService = require('../services/loyaltyService');
const discountService = require('../services/discountService');

// Initialize loyalty service with shopify service dependency
const loyaltyService = new LoyaltyService(shopifyService);

/**
 * GET /api/loyalty/balance
 * Get customer's loyalty status (points, tier, history)
 */
router.get('/balance', async (req, res) => {
  try {
    const { customerId } = req.query;

    if (!customerId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required parameter: customerId',
      });
    }

    console.log('=== LOYALTY BALANCE REQUEST ===');
    console.log('Customer ID:', customerId);

    const status = await loyaltyService.getLoyaltyStatus(customerId);

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('Error fetching loyalty balance:', error);

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to fetch loyalty balance',
      error: error.message,
    });
  }
});

/**
 * POST /api/loyalty/redeem
 * Redeem points for a discount code
 */
router.post('/redeem', async (req, res) => {
  try {
    const { customerId, points } = req.body;

    if (!customerId || !points) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: customerId and points',
      });
    }

    const pointsToRedeem = parseInt(points, 10);
    if (isNaN(pointsToRedeem) || pointsToRedeem <= 0) {
      return res.status(400).json({
        success: false,
        message: 'Points must be a positive number',
      });
    }

    console.log('=== LOYALTY REDEEM REQUEST ===');
    console.log('Customer ID:', customerId);
    console.log('Points to redeem:', pointsToRedeem);

    const result = await loyaltyService.redeemPoints(
      customerId,
      pointsToRedeem,
      discountService
    );

    if (!result.success) {
      return res.status(400).json(result);
    }

    res.json(result);
  } catch (error) {
    console.error('Error redeeming points:', error);

    if (error.message.includes('not found')) {
      return res.status(404).json({
        success: false,
        message: error.message,
      });
    }

    res.status(500).json({
      success: false,
      message: 'Failed to redeem points',
      error: error.message,
    });
  }
});

/**
 * GET /api/loyalty/config
 * Get loyalty program configuration (public, for display purposes)
 */
router.get('/config', async (req, res) => {
  try {
    console.log('=== LOYALTY CONFIG REQUEST ===');

    const config = await loyaltyService.getConfig();

    // Return only public-safe configuration
    res.json({
      success: true,
      tiers: config.tiers,
      redemption: config.redemption,
    });
  } catch (error) {
    console.error('Error fetching loyalty config:', error);

    res.status(500).json({
      success: false,
      message: 'Failed to fetch loyalty config',
      error: error.message,
    });
  }
});

module.exports = router;
