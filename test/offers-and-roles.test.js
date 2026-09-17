/* Run with: node test/offers-and-roles.test.js
 *
 * Two things that can cost real money if they are wrong:
 *
 *   1. Offer pricing. A discount must never come from the request, must never
 *      exceed the subtotal, and must be reflected in what a return refunds.
 *      Refunding an item at its sticker price after a 20% discount hands back
 *      more than was ever charged.
 *   2. Role separation. A client account must not reach the operator's
 *      surfaces, and the last operator must not be removable.
 *
 * Needs a real DATABASE_URL. Razorpay is stubbed, so no live key is needed.
 */

require('dotenv').config();
process.env.EMAIL_PROVIDER = 'console';

const assert = require('assert');
const crypto = require('crypto');

// Stubbed before src/app is required, so the checkout route picks up the
// replacement rather than calling a payment provider from a test.
const razorpay = require('../src/lib/razorpay');
razorpay.createRazorpayOrder = async ({ amountPaise }) => ({ id: 'order_test_' + crypto.randomBytes(6).toString('hex'), amount: amountPaise });

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');
const { newId } = require('../src/lib/ids');
const { applyOffer, computeRefundRatio } = require('../src/lib/offers');
const { resolveReturnItems } = require('../src/lib/returns');

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name);
  }
}

function testPricingMath() {
  console.log('offer pricing');

  const percent = applyOffer({ kind: 'PERCENT', value: 20, minSubtotal: 0, productIds: [] }, 100000, [], 9900);
  check('20 percent off 1000 rupees is 200 rupees', percent.discount === 20000);

  const flat = applyOffer({ kind: 'FLAT', value: 15000, minSubtotal: 0, productIds: [] }, 100000, [], 9900);
  check('a flat offer takes its face value', flat.discount === 15000);

  // A flat offer worth more than the cart must not produce a negative total.
  const oversized = applyOffer({ kind: 'FLAT', value: 500000, minSubtotal: 0, productIds: [] }, 100000, [], 9900);
  check('a flat offer larger than the cart is capped at the subtotal', oversized.discount === 100000);

  const freeShipping = applyOffer({ kind: 'FREE_SHIPPING', value: 0, minSubtotal: 0, productIds: [] }, 100000, [], 9900);
  check('free shipping zeroes shipping and discounts nothing', freeShipping.shipping === 0 && freeShipping.discount === 0);

  // A product-scoped offer must only discount the lines it names, otherwise
  // "20% off jackets" silently becomes 20% off the whole cart.
  const scoped = applyOffer(
    { kind: 'PERCENT', value: 50, minSubtotal: 0, productIds: ['p1'] },
    100000,
    [{ productId: 'p1', lineTotal: 40000 }, { productId: 'p2', lineTotal: 60000 }],
    0
  );
  check('a product-scoped offer only discounts its own lines', scoped.discount === 20000);

  let minSpendRejected = false;
  try {
    applyOffer({ kind: 'PERCENT', value: 10, minSubtotal: 200000, productIds: [] }, 100000, [], 0);
  } catch (err) {
    minSpendRejected = true;
  }
  check('a minimum spend is enforced', minSpendRejected);

  check('no offer means a ratio of 1', computeRefundRatio(100000, 0) === 1);
  check('a 20 percent discount gives a ratio of 0.8', computeRefundRatio(100000, 20000) === 0.8);
  check('a zero subtotal cannot divide by zero', computeRefundRatio(0, 0) === 1);
}

async function testCheckoutAndRefund() {
  console.log('checkout and refund');

  const code = 'TEST' + crypto.randomBytes(3).toString('hex').toUpperCase();
  await db.query(
    `INSERT INTO offers (id, code, title, kind, value, min_subtotal, active) VALUES ($1,$2,'Test offer','PERCENT',25,0,true)`,
    [newId(), code]
  );

  const variant = await db.query(
    `SELECT p.id AS "productId", v.size, v.color FROM products p
       JOIN product_variants v ON v.product_id = p.id
      WHERE v.stock_quantity - v.reserved_quantity > 3 AND p.active = true LIMIT 1`
  );
  assert.ok(variant.rows.length, 'seed data must provide a product with stock');
  const line = variant.rows[0];

  const payload = (offerCode) => ({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: line.productId, size: line.size, color: line.color, qty: 2 }],
    customer: {
      name: 'Test', email: `offer-${crypto.randomBytes(3).toString('hex')}@example.com`,
      phone: '9999999999', address: '1 Test Road', city: 'Lucknow', state: 'UP', pincode: '226001',
    },
    offerCode,
  });

  const plain = await request(app).post('/api/orders/checkout').send(payload(null));
  check('checkout works with no offer', plain.status === 201 && plain.body.discount === 0);

  const discounted = await request(app).post('/api/orders/checkout').send(payload(code));
  check('checkout applies a valid code', discounted.status === 201 && discounted.body.discount > 0);
  check('the discount is a quarter of the subtotal',
    discounted.body.discount === Math.floor(discounted.body.subtotal / 4));
  check('the total is subtotal minus discount plus shipping',
    discounted.body.total === discounted.body.subtotal - discounted.body.discount + discounted.body.shipping);

  // The single most important property here: a browser cannot set the price.
  const tampered = { ...payload(code), discount: 999999, total: 1, subtotal: 1 };
  const tamperedResult = await request(app).post('/api/orders/checkout').send(tampered);
  check('a client-supplied discount is ignored',
    tamperedResult.status === 201 && tamperedResult.body.total === discounted.body.total);

  const badCode = await request(app).post('/api/orders/checkout').send(payload('NOT-A-REAL-CODE'));
  check('an unusable code is reported rather than silently dropped', badCode.status === 400);

  // Refund proration: the customer gets back what they paid, not the sticker.
  const order = await db.query(
    'SELECT id, subtotal, discount, refund_ratio FROM orders WHERE display_id = $1',
    [discounted.body.displayId]
  );
  const orderRow = order.rows[0];
  await db.query("UPDATE orders SET status = 'DELIVERED', delivered_at = now() WHERE id = $1", [orderRow.id]);

  const item = await db.query('SELECT id, price, qty FROM order_items WHERE order_id = $1', [orderRow.id]);
  const resolved = await db.withTransaction((client) =>
    resolveReturnItems(client, orderRow.id, [{ orderItemId: item.rows[0].id, quantity: item.rows[0].qty }])
  );
  const paidForGoods = orderRow.subtotal - orderRow.discount;
  check('a full return refunds what was paid, not the sticker price', resolved.totalRefund === paidForGoods);
  check('the refund is less than the sticker price', resolved.totalRefund < item.rows[0].price * item.rows[0].qty);

  await db.query('DELETE FROM offers WHERE code = $1', [code]);
}

async function testRoles() {
  console.log('roles');

  const operator = request.agent(app);
  const login = await operator.post('/api/admin/login').send({
    email: process.env.ADMIN_EMAIL || 'admin@example.com',
    password: process.env.ADMIN_PASSWORD || 'Str0ngPassw0rd!',
  });
  if (login.status !== 200) {
    console.log('  skipped, no seeded admin account to sign in with');
    return;
  }
  check('the seeded account is an operator', login.body.role === 'operator');

  const email = `client-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const created = await operator.post('/api/admin/users').send({
    name: 'Store Owner', email, password: 'ClientPassword123', role: 'client',
  });
  check('an operator can create a client account', created.status === 201);

  const client = request.agent(app);
  const clientLogin = await client.post('/api/admin/login').send({ email, password: 'ClientPassword123' });
  check('the client can sign in', clientLogin.status === 200 && clientLogin.body.role === 'client');

  const clientErrors = await client.get('/api/admin/errors');
  check('a client cannot read diagnostics', clientErrors.status === 403);

  const clientUsers = await client.get('/api/admin/users');
  check('a client cannot list accounts', clientUsers.status === 403);

  const clientCreate = await client.post('/api/admin/users').send({
    name: 'Sneaky', email: 'sneaky@example.com', password: 'AnotherPass123', role: 'operator',
  });
  check('a client cannot promote anyone to operator', clientCreate.status === 403);

  const clientProducts = await client.get('/api/admin/products');
  check('a client still runs their own shop', clientProducts.status === 200);

  const clientConversations = await client.get('/api/admin/conversations');
  check('a client can read their own conversations', clientConversations.status === 200);

  // Removing the last operator would lock everyone out of the operator-only
  // surfaces with no way back in.
  const users = await operator.get('/api/admin/users');
  const self = users.body.users.find((u) => u.email === (process.env.ADMIN_EMAIL || 'admin@example.com'));
  const removeSelf = await operator.delete('/api/admin/users/' + self.id);
  check('an operator cannot remove their own account', removeSelf.status === 400);

  const clientRow = users.body.users.find((u) => u.email === email);
  const removeClient = await operator.delete('/api/admin/users/' + clientRow.id);
  check('an operator can remove a client account', removeClient.status === 200);
}

async function main() {
  testPricingMath();
  await testCheckoutAndRefund();
  await testRoles();
  await db.pool.end();

  if (failures) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll offer, refund, and role tests passed.');
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
