const test = require('node:test');
const assert = require('node:assert/strict');
const { DiscountService } = require('../services/discountService');

const env = { SHOPIFY_SHOP: 'test-shop.myshopify.com', SHOPIFY_ADMIN_API_ACCESS_TOKEN: 't' };
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('creates a single-use code limited to the customer, amount with cents', async () => {
  let sent;
  const service = new DiscountService({
    env,
    fetchImpl: async (url, opts) => {
      sent = { url, body: JSON.parse(opts.body) };
      return reply(200, { data: { discountCodeBasicCreate: { codeDiscountNode: { id: 'gid://x/1' }, userErrors: [] } } });
    },
  });
  const code = await service.createLoyaltyDiscount(5, '8157833265410');
  assert.match(code, /^LOYALTY-[A-Z2-9]{8}$/);
  assert.match(sent.url, /\/admin\/api\/2026-01\/graphql\.json$/);
  const input = sent.body.variables.discount;
  assert.equal(input.code, code);
  assert.deepEqual(input.context, { customers: { add: ['gid://shopify/Customer/8157833265410'] } });
  assert.equal(input.customerGets.value.discountAmount.amount, '5.00');
  assert.equal(input.usageLimit, 1);
  assert.equal(input.appliesOncePerCustomer, true);
});

test('retries with a new code when the code is taken, gives up after 3', async () => {
  let calls = 0;
  const service = new DiscountService({
    env,
    fetchImpl: async () => {
      calls += 1;
      return reply(200, { data: { discountCodeBasicCreate: { codeDiscountNode: null, userErrors: [{ field: ['basicCodeDiscount', 'code'], code: 'TAKEN', message: 'taken' }] } } });
    },
  });
  assert.equal(await service.createLoyaltyDiscount(5, '1'), null);
  assert.equal(calls, 3);
});

test('permission errors and network errors return null (points get restored by the caller)', async () => {
  const denied = new DiscountService({ env, fetchImpl: async () => reply(403, { errors: 'requires write_discounts' }) });
  assert.equal(await denied.createLoyaltyDiscount(5, '1'), null);
  const offline = new DiscountService({ env, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
  assert.equal(await offline.createLoyaltyDiscount(5, '1'), null);
  const gqlError = new DiscountService({ env, fetchImpl: async () => reply(200, { errors: [{ message: 'Access denied' }] }) });
  assert.equal(await gqlError.createLoyaltyDiscount(5, '1'), null);
});
