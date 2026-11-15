/**
 * Per-customer lock.
 *
 * Loyalty data is a read-modify-write of one customer metafield. Without a
 * lock, two requests for the same customer (double-click on "redeem", a
 * webhook arriving during a redemption) can both read the old balance and
 * both spend it. This serialises work per customer inside this process.
 *
 * It only protects a single Node process: run the app as one instance.
 */

const queues = new Map();

function withCustomerLock(customerId, fn) {
  const key = String(customerId);
  const previous = queues.get(key) || Promise.resolve();

  const run = previous.then(() => fn());
  // Keep the chain alive even if fn throws, so later callers still run.
  const tail = run.catch(() => {});
  queues.set(key, tail);

  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });

  return run;
}

module.exports = { withCustomerLock };
