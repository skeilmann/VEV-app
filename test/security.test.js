const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { verifyCustomerToken, createCustomerToken } = require('../lib/customerToken');
const { requireCustomer } = require('../lib/auth');
const { verifyWebhookSignature } = require('../lib/webhookSignature');
const { normalizeFavorites, readSaved, mergeFavorites } = require('../lib/favorites');
const { withCustomerLock } = require('../lib/customerLock');

const SECRET = 'test-secret-0123456789';
const NOW = 1_800_000_000;

// ---------------------------------------------------------------- tokens

test('token: valid token returns the customer id', () => {
  const token = createCustomerToken(SECRET, 123456789, NOW + 3600);
  assert.equal(verifyCustomerToken(token, SECRET, NOW), '123456789');
});

test('token: matches the hex digest Liquid hmac_sha256 produces', () => {
  // Liquid: {{ "42:1800003600" | hmac_sha256: secret }} -> lowercase hex
  const hex = crypto.createHmac('sha256', SECRET).update('42:1800003600').digest('hex');
  assert.equal(verifyCustomerToken(`42.1800003600.${hex}`, SECRET, NOW), '42');
});

test('token: expired token is rejected', () => {
  const token = createCustomerToken(SECRET, 1, NOW - 1);
  assert.equal(verifyCustomerToken(token, SECRET, NOW), null);
});

test('token: lifetime longer than 7 days is rejected', () => {
  const token = createCustomerToken(SECRET, 1, NOW + 8 * 24 * 3600);
  assert.equal(verifyCustomerToken(token, SECRET, NOW), null);
});

test('token: changing the customer id breaks the signature', () => {
  const token = createCustomerToken(SECRET, 111, NOW + 3600);
  const forged = token.replace(/^111\./, '222.');
  assert.equal(verifyCustomerToken(forged, SECRET, NOW), null);
});

test('token: changing the expiry breaks the signature', () => {
  const token = createCustomerToken(SECRET, 111, NOW + 3600);
  const [id, , sig] = token.split('.');
  assert.equal(verifyCustomerToken(`${id}.${NOW + 7200}.${sig}`, SECRET, NOW), null);
});

test('token: wrong secret, garbage and missing secret are rejected', () => {
  const token = createCustomerToken(SECRET, 5, NOW + 60);
  assert.equal(verifyCustomerToken(token, 'other-secret', NOW), null);
  assert.equal(verifyCustomerToken('5.123.abc', SECRET, NOW), null);
  assert.equal(verifyCustomerToken('', SECRET, NOW), null);
  assert.equal(verifyCustomerToken(undefined, SECRET, NOW), null);
  assert.equal(verifyCustomerToken(token, '', NOW), null);
});

// ---------------------------------------------------------------- auth middleware

function fakeReqRes(authHeader) {
  const req = { get: (h) => (h === 'Authorization' ? authHeader : undefined) };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

test('auth: valid bearer token sets req.customerId and calls next', () => {
  const token = createCustomerToken(SECRET, 77, Math.floor(Date.now() / 1000) + 600);
  const { req, res } = fakeReqRes(`Bearer ${token}`);
  let called = false;
  requireCustomer(() => SECRET)(req, res, () => { called = true; });
  assert.equal(called, true);
  assert.equal(req.customerId, '77');
});

test('auth: missing or bad token gives 401 and does not call next', () => {
  for (const header of [undefined, '', 'Bearer nope', 'x-api-key whatever']) {
    const { req, res } = fakeReqRes(header);
    let called = false;
    requireCustomer(() => SECRET)(req, res, () => { called = true; });
    assert.equal(called, false);
    assert.equal(res.statusCode, 401);
  }
});

test('auth: server without secret refuses (503) instead of letting requests through', () => {
  const { req, res } = fakeReqRes('Bearer anything');
  let called = false;
  requireCustomer(() => undefined)(req, res, () => { called = true; });
  assert.equal(called, false);
  assert.equal(res.statusCode, 503);
});

// ---------------------------------------------------------------- webhook HMAC

test('webhook: correct signature passes, anything else fails', () => {
  const body = JSON.stringify({ id: 1, total_price: '10.00' });
  const good = crypto.createHmac('sha256', SECRET).update(body, 'utf8').digest('base64');
  assert.equal(verifyWebhookSignature(body, good, SECRET), true);
  assert.equal(verifyWebhookSignature(body + ' ', good, SECRET), false);
  assert.equal(verifyWebhookSignature(body, good, 'wrong'), false);
  assert.equal(verifyWebhookSignature(body, undefined, SECRET), false);
  assert.equal(verifyWebhookSignature(body, 'short', SECRET), false);
  assert.equal(verifyWebhookSignature(undefined, good, SECRET), false);
  assert.equal(verifyWebhookSignature(body, good, undefined), false);
});

// ---------------------------------------------------------------- favorites

test('favorites: normalises ids and drops duplicates', () => {
  assert.deepEqual(
    normalizeFavorites([{ id: '10', handle: 'lak-gel' }, { id: 10, handle: 'lak-gel' }, { id: 11 }]),
    [{ id: 10, handle: 'lak-gel' }, { id: 11, handle: '' }]
  );
});

test('favorites: rejects bad input', () => {
  assert.equal(normalizeFavorites('nope'), null);
  assert.equal(normalizeFavorites([{ id: 'abc' }]), null);
  assert.equal(normalizeFavorites([{ id: -1 }]), null);
  assert.equal(normalizeFavorites([{ id: 1, handle: '<script>' }]), null);
  assert.equal(normalizeFavorites(Array.from({ length: 201 }, (_, i) => ({ id: i + 1 }))), null);
});

test('favorites: Cyrillic handles are accepted', () => {
  assert.deepEqual(normalizeFavorites([{ id: 1, handle: 'гель-лак' }]), [{ id: 1, handle: 'гель-лак' }]);
});

test('favorites: readSaved tolerates broken stored data; merge keeps existing first', () => {
  assert.deepEqual(readSaved('not json'), []);
  assert.deepEqual(readSaved(JSON.stringify({ saved: [{ id: 1, handle: 'a' }] })), [{ id: 1, handle: 'a' }]);
  assert.deepEqual(
    mergeFavorites([{ id: 1, handle: 'a' }], [{ id: 2, handle: 'b' }, { id: 1, handle: 'a' }]),
    [{ id: 1, handle: 'a' }, { id: 2, handle: 'b' }]
  );
});

// ---------------------------------------------------------------- lock

test('lock: work for one customer runs one at a time; a failure does not block the next', async () => {
  const order = [];
  const slow = (label, ms) => () => new Promise((r) => setTimeout(() => { order.push(label); r(label); }, ms));
  const failing = () => Promise.reject(new Error('boom'));

  const a = withCustomerLock(1, slow('a', 30));
  const b = withCustomerLock(1, failing);
  const c = withCustomerLock(1, slow('c', 1));
  await a;
  await assert.rejects(b, /boom/);
  await c;
  assert.deepEqual(order, ['a', 'c']);
});
