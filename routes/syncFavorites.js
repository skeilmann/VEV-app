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

    // Check if favorites is an array and contains only strings or numbers
    if (!Array.isArray(favorites) || !favorites.every(id => typeof id === 'string' || typeof id === 'number')) {
      return res.status(400).json({
        success: false,
        message: 'Favorites must be an array of product IDs (strings or numbers)',
      });
    }

    // Convert all IDs to string for consistency
    const favoriteProductIds = favorites.map(String);

    // Get existing metafield
    const existingMetafield = await shopifyService.getCustomerMetafield(customerId);

    // Parse existing data or create new structure
    const existingData = existingMetafield
      ? JSON.parse(existingMetafield.value)
      : null;

    // Merge favorites (pass the array of product IDs)
    const mergedData = await shopifyService.mergeFavorites(existingData, favoriteProductIds);

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
    // Send a more specific error if customer not found
    if (error.message.includes('Customer') && error.message.includes('not found')) {
        return res.status(404).json({
            success: false,
            message: error.message
        });
    }
    res.status(500).json({
      success: false,
      message: 'Failed to sync favorites',
      error: error.message,
    });
  }
});

module.exports = router; 