const express = require('express');
const router = express.Router();
const shopifyService = require('../services/shopifyService');

router.post('/sync-favorites', async (req, res) => {
  try {
    const { customerId, favorites } = req.body;

    // Validate input
    if (!customerId || !favorites) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: customerId and favorites',
      });
    }

    if (!Array.isArray(favorites)) {
      return res.status(400).json({
        success: false,
        message: 'Favorites must be an array',
      });
    }

    // Validate each favorite item
    for (const favorite of favorites) {
      if (!favorite.productId) {
        return res.status(400).json({
          success: false,
          message: 'Each favorite must have a productId',
        });
      }
    }

    // Get existing metafield
    const existingMetafield = await shopifyService.getCustomerMetafield(customerId);

    // Parse existing data or create new structure
    const existingData = existingMetafield
      ? JSON.parse(existingMetafield.value)
      : null;

    // Merge favorites
    const mergedData = shopifyService.mergeFavorites(existingData, favorites);

    // Update or create metafield
    if (existingMetafield) {
      await shopifyService.updateCustomerMetafield(
        customerId,
        existingMetafield.id,
        mergedData
      );
    } else {
      await shopifyService.createCustomerMetafield(customerId, mergedData);
    }

    res.json({
      success: true,
      message: 'Favorites synced successfully',
    });
  } catch (error) {
    console.error('Error syncing favorites:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to sync favorites',
      error: error.message,
    });
  }
});

module.exports = router; 