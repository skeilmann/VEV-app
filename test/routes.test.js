/**
 * Route-level checks through the real Express app.
 * Only requests that are rejected (or need no Shopify call) are sent, so these
 * tests never reach Shopify. Env is set before loading the app; dotenv does
 * not override variables that are already set.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

process.env.SHOPIFY_SHOP = 'test-shop.myshopify.com';
process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN = 'test-token';
process.env.SHOPIFY_API_KEY = 'test-key';
process.env.SHOPIFY_API_SECRET = 'test-webhook-secret';
process.env.SHOPIFY_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.CUSTOMER_TOKEN_SECRET = 'test-customer-secret';
process.env.ALLOWED_ORIGINS = 'https://shop.example';

const app = require('../server');
const { earnableAmount } = require('../routes/webhooks');

let server;
let base;

test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

const sign = (body) => crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('base64');

async function postWebhook(path, payload, { hmac, shop = 'test-shop.myshopify.com' } = {}) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', 'X-Shopify-Shop-Domain': shop };
  if (hmac !== null) headers['X-Shopify-Hmac-SHA256'] = hmac || sign(body);
  return fetch(`${base}/api/webhooks/${path}`, { method: 'POST', headers, body });
}

test('webhook without signature is rejected', async () => {
  const res = await postWebhook('orders-paid', { id: 1, customer: { id: 2 }, total_price: '100' }, { hmac: null });
  assert.equal(res.status, 401);
});

test('webhook with a wrong signature is rejected', async () => {
  const res = await postWebhook('orders-paid', { id: 1 }, { hmac: sign('something else') });
  assert.equal(res.status, 401);
});

test('webhook signed correctly but from another shop is rejected', async () => {
  const res = await postWebhook('orders-paid', { id: 1 }, { shop: 'evil.myshopify.com' });
  assert.equal(res.status, 401);
});

test('webhook signed correctly from this shop is accepted (guest order: no Shopify call)', async () => {
  const res = await postWebhook('orders-paid', { id: 1, total_price: '100' });
  assert.equal(res.status, 200);
});

test('webhook signature is checked against the exact raw bytes (non-ASCII body)', async () => {
  const res = await postWebhook('orders-paid', { id: 1, note: 'Гель-лак ✨', total_price: '1' });
  assert.equal(res.status, 200);
});

test('favorites sync without a customer token is rejected', async () => {
  const res = await fetch(`${base}/api/sync-favorites`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ customerId: 1, favorites: [{ id: 1, handle: 'a' }] }),
  });
  assert.equal(res.status, 401);
});

test('old API-key style requests to loyalty are rejected', async () => {
  const res = await fetch(`${base}/api/loyalty/balance?customerId=1`, { headers: { 'x-api-key': 'Gheorghe2025VeV' } });
  assert.equal(res.status, 401);
  const redeem = await fetch(`${base}/api/loyalty/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': 'Gheorghe2025VeV' },
    body: JSON.stringify({ customerId: 1, points: 100 }),
  });
  assert.equal(redeem.status, 401);
});

test('CORS allows the store origin only', async () => {
  const ok = await fetch(`${base}/ping`, { headers: { Origin: 'https://shop.example' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://shop.example');
  const other = await fetch(`${base}/ping`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('gift cards bought in an order do not earn points; shop currency is used', () => {
  assert.equal(
    earnableAmount({
      total_price: '999',
      total_price_set: { shop_money: { amount: '600.00' } },
      line_items: [
        { gift_card: true, price: '100.00', quantity: 2 },
        { gift_card: false, price: '400.00', quantity: 1 },
      ],
    }),
    400
  );
});
