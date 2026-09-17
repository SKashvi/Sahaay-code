/* Run with: node test/orders-by-email.test.js
 *
 * Verification is on the email, and the email alone.
 *
 * It used to take an email plus an order id, which meant a customer with three
 * orders signed out and verified again twice to look at all of them. The order
 * id was never a credential doing that work: it travels in the confirmation
 * email, the shipping notice and the courier's tracking page. Possession of
 * the inbox is the credential, and always was, because that is where the code
 * is sent.
 *
 * So the properties that matter are: a code is sent on an email with any
 * order, the verified session lists every order on that email, opening one
 * needs no second sign-in, and the order id is now a filter that cannot be
 * used to reach an order on somebody else's email.
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath, filename: razorpayPath, loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async ({ amountPaise, receipt }) => ({ id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'), amount: amountPaise, receipt }),
    verifyPaymentSignature: () => true, verifyWebhookSignature: () => true,
    refundPayment: async () => ({ id: 'rfnd_MOCK', amount: 0 }),
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');
const { signCustomerToken } = require('../src/lib/auth');
const { listOrdersForEmail, buildOrderViewForEmail } = require('../src/lib/orderView');

const agent = request(app);

async function placeOrder(email) {
  const products = (await agent.get('/api/products')).body.products;
  const product = products[0];
  const size = product.sizes[0];
  const color = product.colors[0].name;
  await db.query(
    'UPDATE product_variants SET stock_quantity = 50, reserved_quantity = 0 WHERE product_id = $1 AND size = $2 AND color = $3',
    [product.id, size, color]
  );
  const res = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size, color, qty: 1 }],
    customer: {
      name: 'List Test', email, phone: '9999999999',
      address: '1 Test Street', city: 'Mumbai', state: 'MH', pincode: '400001',
    },
  });
  assert.strictEqual(res.status, 201, `checkout failed: ${JSON.stringify(res.body)}`);
  return res.body.displayId;
}

/* The cookie the widget holds after verifying. The token still carries an
 * orderId, because a session that arrived from a specific order should land on
 * it, but nothing about the listing depends on that field. */
function cookieFor(email, sessionId, orderId, orderDisplayId) {
  return `customer_session=${signCustomerToken({ sessionId, email, orderId, orderDisplayId })}`;
}

async function testCodeGoesOutOnEmailAlone() {
  const email = `multi-${crypto.randomBytes(4).toString('hex')}@example.test`;
  await placeOrder(email);

  // No displayId in the body at all. This is the request the widget now makes.
  const res = await agent.post('/api/session/request-code').send({
    sessionId: crypto.randomUUID(),
    email,
  });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.ok);

  // An address with no orders gets the identical answer, so this cannot be
  // used to find out which addresses have shopped here.
  const unknown = await agent.post('/api/session/request-code').send({
    sessionId: crypto.randomUUID(),
    email: `nobody-${crypto.randomBytes(4).toString('hex')}@example.test`,
  });
  assert.strictEqual(unknown.status, 200);
  assert.deepStrictEqual(unknown.body, res.body, 'the answer must not reveal whether the email exists');
  console.log('  ok  a code is requested with an email alone, and the answer never reveals whether it exists');
}

async function testOneSignInListsEveryOrder() {
  const email = `multi-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const first = await placeOrder(email);
  const second = await placeOrder(email);
  const third = await placeOrder(email);

  // Somebody else's order, on the same product, to prove the scoping.
  const otherEmail = `other-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const otherOrder = await placeOrder(otherEmail);

  const sessionId = crypto.randomUUID();
  const row = await db.query('SELECT id FROM orders WHERE display_id = $1', [first]);
  const cookie = cookieFor(email, sessionId, row.rows[0].id, first);

  const res = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId });
  assert.strictEqual(res.status, 200);
  const ids = res.body.orders.map((o) => o.displayId);

  assert.strictEqual(ids.length, 3, `expected three orders, got ${ids.join(', ')}`);
  [first, second, third].forEach((id) => assert.ok(ids.includes(id), `${id} must be listed`));
  assert.ok(!ids.includes(otherOrder), 'another email\'s order must never appear');
  // Newest first.
  assert.strictEqual(ids[0], third, 'the newest order is first');

  // A row carries what it needs to render without a second request.
  const rowView = res.body.orders[0];
  assert.ok(rowView.statusLabel, 'a label, not a raw enum');
  assert.strictEqual(rowView.itemCount, 1);
  assert.ok(rowView.total);
  console.log('  ok  one sign-in lists every order on that email, newest first, and no one else\'s');
}

async function testOpeningAnOrderNeedsNoSecondSignIn() {
  const email = `multi-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const first = await placeOrder(email);
  const second = await placeOrder(email);

  const sessionId = crypto.randomUUID();
  const row = await db.query('SELECT id FROM orders WHERE display_id = $1', [first]);
  // Verified against the FIRST order. Opening the second is the exact case
  // that used to require signing out and verifying again.
  const cookie = cookieFor(email, sessionId, row.rows[0].id, first);

  const res = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId, displayId: second });
  assert.strictEqual(res.status, 200, 'no re-auth to open a different order on the same email');
  assert.ok(res.body.detail, 'the detail comes back');
  assert.strictEqual(res.body.detail.displayId, second);
  assert.ok(Array.isArray(res.body.detail.items) && res.body.detail.items.length, 'with its line items');
  assert.strictEqual(res.body.orders.length, 2, 'and the list comes along, so going back needs no request');
  console.log('  ok  opening a different order on the same email needs no second sign-in');
}

async function testTheOrderIdIsAFilterNotACredential() {
  const mine = `mine-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const theirs = `theirs-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const myOrder = await placeOrder(mine);
  const theirOrder = await placeOrder(theirs);

  const sessionId = crypto.randomUUID();
  const row = await db.query('SELECT id FROM orders WHERE display_id = $1', [myOrder]);
  const cookie = cookieFor(mine, sessionId, row.rows[0].id, myOrder);

  // Knowing another customer's order id is now worth nothing, which is the
  // point: it was never a secret to begin with.
  const stolen = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId, displayId: theirOrder });
  assert.strictEqual(stolen.status, 404, 'an order id on another email must not resolve');

  const stolenCancel = await agent.post('/api/orders/mine/cancel').set('Cookie', cookie).send({ sessionId, displayId: theirOrder });
  assert.strictEqual(stolenCancel.status, 404, 'and must not be cancellable');
  const still = await db.query('SELECT status FROM orders WHERE display_id = $1', [theirOrder]);
  assert.notStrictEqual(still.rows[0].status, 'CANCELLED', 'their order is untouched');

  // As a filter over my own list, it works.
  const filtered = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId, search: myOrder });
  assert.strictEqual(filtered.body.orders.length, 1);
  assert.strictEqual(filtered.body.orders[0].displayId, myOrder);

  const noMatch = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId, search: 'VEL-NOTHING' });
  assert.strictEqual(noMatch.body.orders.length, 0, 'a filter that matches nothing is an empty list, not an error');
  console.log('  ok  the order id filters your own list and cannot reach anybody else\'s');
}

async function testCancelPicksTheNamedOrder() {
  const email = `cancel-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const keep = await placeOrder(email);
  const drop = await placeOrder(email);

  const sessionId = crypto.randomUUID();
  const row = await db.query('SELECT id FROM orders WHERE display_id = $1', [keep]);
  // Verified against `keep`, cancelling `drop`. Without the display id the
  // panel would cancel whichever order the session happened to verify on.
  const cookie = cookieFor(email, sessionId, row.rows[0].id, keep);

  const res = await agent.post('/api/orders/mine/cancel').set('Cookie', cookie).send({ sessionId, displayId: drop });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.strictEqual(res.body.displayId, drop, 'the named order is the one cancelled');

  const after = await db.query('SELECT display_id, status FROM orders WHERE display_id = ANY($1::text[])', [[keep, drop]]);
  const byId = Object.fromEntries(after.rows.map((r) => [r.display_id, r.status]));
  assert.strictEqual(byId[drop], 'CANCELLED');
  assert.notStrictEqual(byId[keep], 'CANCELLED', 'the other order is untouched');
  console.log('  ok  cancelling acts on the order the panel named, not the one the session verified on');
}

async function testTheLibraryFunctionsScopeByEmail() {
  const email = `lib-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const mine = await placeOrder(email);
  const theirs = await placeOrder(`else-${crypto.randomBytes(4).toString('hex')}@example.test`);

  const list = await listOrdersForEmail(email);
  assert.strictEqual(list.length, 1);
  assert.strictEqual(list[0].displayId, mine);

  assert.ok(await buildOrderViewForEmail(email, mine), 'my own order resolves');
  assert.strictEqual(await buildOrderViewForEmail(email, theirs), null, 'someone else\'s does not');
  // Case should not be a way past the scoping.
  assert.ok(await buildOrderViewForEmail(email.toUpperCase(), mine), 'email matching is case insensitive');
  console.log('  ok  the listing and detail helpers scope by email, case insensitively');
}

async function main() {
  console.log('orders by email');
  await testCodeGoesOutOnEmailAlone();
  await testOneSignInListsEveryOrder();
  await testOpeningAnOrderNeedsNoSecondSignIn();
  await testTheOrderIdIsAFilterNotACredential();
  await testCancelPicksTheNamedOrder();
  await testTheLibraryFunctionsScopeByEmail();
  console.log('\nAll orders by email tests passed.');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
