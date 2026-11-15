/**
 * POST /api/sync-favorites
 *
 * Saves the logged-in customer's favorites to customer metafield
 * custom.fav_prod as { saved: [{ id, handle }] } — the field and format the
 * theme reads in layout/theme.liquid.
 *
 * Body: { favorites: [{ id, handle }], mode: "replace" | "merge" }
 *   replace (default): the list is the customer's full current favorites
 *   merge: add to what is stored (guest favorites moved over at login)
 *
 * The customer comes from the verified token (req.customerId), never the body.
 */

const express = require('express');
const router = express.Router();
const shopifyService = require('../services/shopifyService');
const { withCustomerLock } = require('../lib/customerLock');
const { requireCustomer } = require('../lib/auth');
const { normalizeFavorites, readSaved, mergeFavorites } = require('../lib/favorites');

const NAMESPACE = 'custom';
const KEY = 'fav_prod';

router.post('/sync-favorites', requireCustomer(), async (req, res) => {
  const customerId = req.customerId;
  const mode = req.body?.mode === 'merge' ? 'merge' : 'replace';
  const incoming = normalizeFavorites(req.body?.favorites);

  if (!incoming) {
    return res.status(400).json({
      success: false,
      message: 'favorites must be an array of { id, handle } (max 200)',
    });
  }

  try {
    const saved = await withCustomerLock(`fav:${customerId}`, async () => {
      const existing = await shopifyService.getCustomerMetafieldByNamespaceKey(customerId, NAMESPACE, KEY);
      const list = mode === 'merge' ? mergeFavorites(readSaved(existing && existing.value), incoming) : incoming;
      const value = { saved: list };

      if (existing) {
        await shopifyService.updateMetafield(customerId, existing.id, value);
      } else {
        await shopifyService.createCustomerMetafieldByNamespaceKey(customerId, NAMESPACE, KEY, value, 'json');
      }
      return list;
    });

    res.json({ success: true, saved });
  } catch (error) {
    console.error('Error syncing favorites:', error.message);
    if (error.message.includes('not found')) {
      return res.status(404).json({ success: false, message: 'Customer not found' });
    }
    res.status(500).json({ success: false, message: 'Failed to sync favorites' });
  }
});

module.exports = router;
