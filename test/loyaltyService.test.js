const test = require('node:test');
const assert = require('node:assert/strict');

const LoyaltyService = require('../services/loyaltyService');

/** In-memory stand-in for shopifyService (one customer metafield). */
function fakeShopify(initial) {
  const store = { value: initial ? JSON.stringify(initial) : null, writes: [] };
  return {
    store,
    failReads: false,
    async getShopMetafield() { return null; },
    async getCustomerMetafieldByNamespaceKey() {
      await new Promise((r) => setTimeout(r, 5));
      if (this.failReads) throw new Error('Shopify 502');
      return store.value ? { id: 99, value: store.value } : null;
    },
    async updateMetafield(customerId, id, data) {
      await new Promise((r) => setTimeout(r, 5));
      store.value = JSON.stringify(data);
      store.writes.push(JSON.parse(store.value));
    },
    async createCustomerMetafieldByNamespaceKey(customerId, ns, key, data) {
      store.value = JSON.stringify(data);
      store.writes.push(JSON.parse(store.value));
    },
  };
}

const balance = (shop) => JSON.parse(shop.store.value).points_balance;
const account = (points) => ({ points_balance: points, lifetime_spend: 0, tier: 'bronze', history: [] });

test('redeem: points are saved as spent before the discount code is created', async () => {
  const shop = fakeShopify(account(150));
  const service = new LoyaltyService(shop);
  let balanceWhenCodeCreated = null;
  const discounts = {
    async createLoyaltyDiscount() {
      balanceWhenCodeCreated = balance(shop);
      return 'LOYALTY-TEST1234';
    },
  };

  const result = await service.redeemPoints('1', 100, discounts);
  assert.equal(result.success, true);
  assert.equal(balanceWhenCodeCreated, 50);
  assert.equal(balance(shop), 50);
  assert.equal(JSON.parse(shop.store.value).history[0].discount_code, 'LOYALTY-TEST1234');
});

test('redeem: points come back when the code cannot be created', async () => {
  const shop = fakeShopify(account(150));
  const service = new LoyaltyService(shop);
  const result = await service.redeemPoints('1', 100, { async createLoyaltyDiscount() { return null; } });
  assert.equal(result.success, false);
  assert.equal(balance(shop), 150);
  assert.equal(JSON.parse(shop.store.value).history.length, 0);
});

test('redeem: points come back when code creation throws', async () => {
  const shop = fakeShopify(account(150));
  const service = new LoyaltyService(shop);
  const result = await service.redeemPoints('1', 100, {
    async createLoyaltyDiscount() { throw new Error('network'); },
  });
  assert.equal(result.success, false);
  assert.equal(balance(shop), 150);
});

test('redeem: two simultaneous redemptions cannot spend the same points twice', async () => {
  const shop = fakeShopify(account(150));
  const service = new LoyaltyService(shop);
  let codes = 0;
  const discounts = {
    async createLoyaltyDiscount() {
      await new Promise((r) => setTimeout(r, 10));
      codes += 1;
      return `LOYALTY-${codes}`;
    },
  };

  const results = await Promise.all([
    service.redeemPoints('1', 100, discounts),
    service.redeemPoints('1', 100, discounts),
  ]);

  assert.equal(results.filter((r) => r.success).length, 1);
  assert.equal(codes, 1);
  assert.equal(balance(shop), 50);
});

test('redeem: below minimum, above balance and non-integer amounts are refused', async () => {
  const shop = fakeShopify(account(150));
  const service = new LoyaltyService(shop);
  const never = { async createLoyaltyDiscount() { throw new Error('should not be called'); } };
  assert.equal((await service.redeemPoints('1', 50, never)).success, false);
  assert.equal((await service.redeemPoints('1', 200, never)).success, false);
  assert.equal((await service.redeemPoints('1', 100.5, never)).success, false);
  assert.equal(balance(shop), 150);
});

test('award: the same order is only counted once, even when webhooks arrive together', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  await Promise.all([
    service.awardPoints('1', 555, 200),
    service.awardPoints('1', 555, 200),
  ]);
  assert.equal(balance(shop), 200);
  // Without the lock both calls read the empty account and both write.
  assert.equal(shop.store.writes.length, 1);
});

test('award: a different order in parallel is not lost', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  await Promise.all([service.awardPoints('1', 1, 100), service.awardPoints('1', 2, 100)]);
  assert.equal(balance(shop), 200);
});

test('award: a failed read is an error, not a fresh account that overwrites the balance', async () => {
  const shop = fakeShopify(account(500));
  shop.failReads = true;
  const service = new LoyaltyService(shop);
  await assert.rejects(service.awardPoints('1', 777, 100), /Shopify 502/);
  assert.equal(balance(shop), 500);
  assert.equal(shop.store.writes.length, 0);
});

test('refund: the same refund is only reversed once', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  await service.awardPoints('1', 900, 300);
  assert.equal(balance(shop), 300);

  await service.reversePoints('1', 900, 100, 4001);
  await service.reversePoints('1', 900, 100, 4001);
  assert.equal(balance(shop), 200);

  await service.reversePoints('1', 900, 100, 4002);
  assert.equal(balance(shop), 100);
});

const stored = (shop) => JSON.parse(shop.store.value);

test('refund after spending the points leaves a debt and lowers tier and lifetime spend', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  await service.awardPoints('1', 10, 500); // reaches silver: 750 points
  assert.equal(stored(shop).tier, 'silver');
  assert.equal(balance(shop), 750);

  const redeemed = await service.redeemPoints('1', 700, { async createLoyaltyDiscount() { return 'LOYALTY-X'; } });
  assert.equal(redeemed.success, true);
  assert.equal(balance(shop), 50);

  await service.reversePoints('1', 10, 500, 'r1');
  assert.equal(balance(shop), -700);
  assert.equal(stored(shop).tier, 'bronze');
  assert.equal(stored(shop).lifetime_spend, 0);

  const again = await service.redeemPoints('1', 100, { async createLoyaltyDiscount() { return 'LOYALTY-Y'; } });
  assert.equal(again.success, false);
});

test('refund on an order that earned nothing takes nothing', async () => {
  const shop = fakeShopify(account(300));
  const service = new LoyaltyService(shop);
  const result = await service.reversePoints('1', 'old-order', 1000, 'r9');
  assert.equal(result.points_deducted, 0);
  assert.equal(balance(shop), 300);
});

test('refunds never take more than the order earned, and small refunds add up', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  await service.awardPoints('1', 20, 100); // 100 points
  for (let i = 0; i < 10; i += 1) {
    await service.reversePoints('1', 20, 10, `small-${i}`); // ten refunds of 10 = full refund
  }
  assert.equal(balance(shop), 0);
  await service.reversePoints('1', 20, 50, 'extra'); // more than was paid
  assert.equal(balance(shop), 0);
});

test('duplicates are detected even after 20+ newer history entries', async () => {
  const shop = fakeShopify(account(0));
  const service = new LoyaltyService(shop);
  for (let i = 1; i <= 25; i += 1) await service.awardPoints('1', `o${i}`, 10);
  const before = balance(shop);
  const replay = await service.awardPoints('1', 'o1', 10);
  assert.equal(replay.duplicate, true);
  assert.equal(balance(shop), before);

  await service.reversePoints('1', 'o2', 10, 'ref-a');
  for (let i = 26; i <= 50; i += 1) await service.awardPoints('1', `o${i}`, 10);
  const mid = balance(shop);
  await service.reversePoints('1', 'o2', 10, 'ref-a');
  assert.equal(balance(shop), mid);
});

test('old records without the orders list still detect duplicates (migration from history)', async () => {
  const legacy = account(10);
  legacy.history = [{ type: 'earn', points: 10, order_id: '77', order_total: 10, tier_at_purchase: 'bronze' }];
  const shop = fakeShopify(legacy);
  const service = new LoyaltyService(shop);
  const replay = await service.awardPoints('1', 77, 10);
  assert.equal(replay.duplicate, true);
  assert.equal(balance(shop), 10);
});

test('config: a failed read is an error, not a silent switch to default rates', async () => {
  const shop = fakeShopify(account(0));
  shop.getShopMetafield = async () => { throw new Error('Shopify 503'); };
  const service = new LoyaltyService(shop);
  await assert.rejects(service.awardPoints('1', 1, 100), /Shopify 503/);
  assert.equal(shop.store.writes.length, 0);
});

test('config: partial stored config keeps defaults; invalid config is refused', () => {
  const { buildConfig } = LoyaltyService;
  const merged = buildConfig({ redemption: { discount_value: 10 }, tiers: { gold: { min_spend: 3000 } } });
  assert.equal(merged.redemption.points_required, 100);
  assert.equal(merged.redemption.discount_value, 10);
  assert.equal(merged.tiers.gold.points_per_dollar, 2);
  assert.equal(merged.tiers.gold.min_spend, 3000);
  assert.throws(() => buildConfig({ redemption: { points_required: 'lots' } }));
  assert.throws(() => buildConfig({ tiers: { bronze: { min_spend: 10 } } }));
});

test('redeem: discount amounts are rounded to cents', async () => {
  const shop = fakeShopify(account(300));
  shop.getShopMetafield = async () => ({ value: JSON.stringify({ redemption: { points_required: 100, discount_value: 0.1 } }) });
  const service = new LoyaltyService(shop);
  let amount = null;
  await service.redeemPoints('1', 300, { async createLoyaltyDiscount(a) { amount = a; return 'C'; } });
  assert.equal(amount, 0.3);
});
