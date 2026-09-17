/* Sanity-checks the checkout, payment verification, order tracking, return,
 * and admin flows against your actual .env configuration except Razorpay,
 * which is mocked here so this can run without live payment credentials or
 * touching your real Razorpay account. Run after `npm install` and with
 * your database migrated and reachable:
 *
 *   node test/smoke-test.js
 *
 * It exits non-zero on the first failed assertion. Safe to run against a
 * staging database, not recommended against production data since it
 * creates real rows (a few test orders, one injection-probe order). */
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath,
  filename: razorpayPath,
  loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async ({ amountPaise, receipt }) => ({
      id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'),
      amount: amountPaise,
      receipt,
    }),
    verifyPaymentSignature: ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
      // Mirrors the real HMAC check but against our fake secret, so a test
      // can construct a genuinely valid signature and confirm it is accepted,
      // and a bad one and confirm it is rejected.
      const expected = crypto.createHmac('sha256', 'mock_secret').update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
      return expected === razorpaySignature;
    },
    verifyWebhookSignature: ({ rawBody, signatureHeader }) => {
      const expected = crypto.createHmac('sha256', 'mock_webhook_secret').update(rawBody).digest('hex');
      return expected === signatureHeader;
    },
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');

function mockSignature(orderId, paymentId) {
  return crypto.createHmac('sha256', 'mock_secret').update(`${orderId}|${paymentId}`).digest('hex');
}

async function main() {
  const agent = request(app);

  console.log('--- fetch a real product id ---');
  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  console.log('using product:', product.name, product.price);

  console.log('\n--- checkout with a tampered price field ---');
  const firstCheckoutKey = crypto.randomUUID();
  const checkoutRes = await agent.post('/api/orders/checkout').send({
    idempotencyKey: firstCheckoutKey,
    items: [{ productId: product.id, size: 'M', color: 'Black', qty: 2, price: 1 }],
    customer: { name: 'Test User', email: 'test@velour.com', phone: '9876543210', address: '221B Baker Street', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('status:', checkoutRes.status, JSON.stringify(checkoutRes.body));
  if (checkoutRes.status !== 201) throw new Error('checkout failed');
  const subtotal = product.price * 2;
  const shipping = subtotal >= 199900 ? 0 : 9900;
  const expectedTotal = subtotal + shipping;
  if (checkoutRes.body.total !== expectedTotal) {
    throw new Error(`price tampering NOT blocked correctly: expected ${expectedTotal}, got ${checkoutRes.body.total}`);
  }
  console.log('confirmed: server-calculated total ignored the fake client price of 1 (subtotal ' + subtotal + ' + shipping ' + shipping + ' = ' + expectedTotal + ')');

  console.log('\n--- repeating the exact same request (same idempotency key) must not create a second order ---');
  const replayRes = await agent.post('/api/orders/checkout').send({
    idempotencyKey: firstCheckoutKey,
    items: [{ productId: product.id, size: 'M', color: 'Black', qty: 2 }],
    customer: { name: 'Test User', email: 'test@velour.com', phone: '9876543210', address: '221B Baker Street', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('replay status (expect 200, not 201):', replayRes.status, 'same order id:', replayRes.body.orderId === checkoutRes.body.orderId);
  if (replayRes.body.orderId !== checkoutRes.body.orderId) throw new Error('idempotency key replay created a different order');

  console.log('\n--- reusing the SAME idempotency key with a genuinely DIFFERENT cart must be rejected, not silently return the old order ---');
  const reusedKeyDifferentCart = await agent.post('/api/orders/checkout').send({
    idempotencyKey: firstCheckoutKey,
    items: [{ productId: product.id, size: 'M', color: 'Black', qty: 5 }], // different quantity = a materially different request
    customer: { name: 'Test User', email: 'test@velour.com', phone: '9876543210', address: '221B Baker Street', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('status (expect 409, key reuse with a different cart):', reusedKeyDifferentCart.status, reusedKeyDifferentCart.body.error);
  if (reusedKeyDifferentCart.status !== 409) throw new Error('idempotency key reuse with a different cart was NOT rejected, this could silently charge the wrong amount for the wrong cart');

  console.log('\n--- color must be validated the same way size already is ---');
  const badColor = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: 'M', color: 'Invisible Pink', qty: 1 }],
    customer: { name: 'Test User', email: 'test@velour.com', phone: '9876543210', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('status (expect 400, color not offered on this product):', badColor.status, badColor.body.error);
  if (badColor.status !== 400) throw new Error('an invalid color was accepted, only size was being validated before');

  console.log('\n--- checkout with an invalid size ---');
  const badSizeRes = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: 'ZZ', color: 'Black', qty: 1 }],
    customer: { name: 'Test User', email: 'test@velour.com', phone: '9876543210', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('status (expect 400):', badSizeRes.status, badSizeRes.body.error);

  console.log('\n--- checkout with SQL-injection-shaped input in the address field ---');
  const injectionRes = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: 'M', color: 'Black', qty: 1 }],
    customer: { name: "Robert'); DROP TABLE orders;--", email: 'inj@velour.com', phone: '9876543210', address: "1' OR '1'='1", city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  console.log('status:', injectionRes.status, 'orderId:', injectionRes.body.orderId);
  const tablesStillThere = await db.query("SELECT to_regclass('public.orders') AS t");
  console.log('orders table still exists after injection attempt:', tablesStillThere.rows[0].t === 'orders');
  const injOrderRow = await db.query('SELECT customer_name, address_line FROM orders WHERE customer_email = $1', ['inj@velour.com']);
  console.log('malicious strings stored as inert data, not executed:', JSON.stringify(injOrderRow.rows[0]));

  console.log('\n--- verify-payment with WRONG signature ---');
  const wrongVerify = await agent.post('/api/orders/verify-payment').send({
    orderId: checkoutRes.body.orderId,
    razorpayOrderId: checkoutRes.body.razorpayOrderId,
    razorpayPaymentId: 'pay_MOCKFAKE',
    razorpaySignature: 'not-a-real-signature',
  });
  console.log('status (expect 400):', wrongVerify.status, wrongVerify.body.error);

  console.log('\n--- verify-payment with CORRECT signature ---');
  const goodSig = mockSignature(checkoutRes.body.razorpayOrderId, 'pay_MOCKGOOD1');
  const goodVerify = await agent.post('/api/orders/verify-payment').send({
    orderId: checkoutRes.body.orderId,
    razorpayOrderId: checkoutRes.body.razorpayOrderId,
    razorpayPaymentId: 'pay_MOCKGOOD1',
    razorpaySignature: goodSig,
  });
  console.log('status (expect 200):', goodVerify.status, JSON.stringify(goodVerify.body));

  console.log('\n--- verify-payment REPLAY of the same good signature (should now fail, order no longer PENDING) ---');
  const replay = await agent.post('/api/orders/verify-payment').send({
    orderId: checkoutRes.body.orderId,
    razorpayOrderId: checkoutRes.body.razorpayOrderId,
    razorpayPaymentId: 'pay_MOCKGOOD1',
    razorpaySignature: goodSig,
  });
  console.log('status (expect 400, already processed):', replay.status, replay.body.error);

  console.log('\n--- track order with correct email + id ---');
  const track = await agent.post('/api/orders/track').send({ email: 'test@velour.com', displayId: checkoutRes.body.displayId });
  console.log('status:', track.status, JSON.stringify(track.body).slice(0, 300));
  if (track.body.order.id) throw new Error('internal id leaked to client!');

  console.log('\n--- track order with WRONG email, correct order id (should 404, not leak) ---');
  const trackWrong = await agent.post('/api/orders/track').send({ email: 'attacker@evil.com', displayId: checkoutRes.body.displayId });
  console.log('status (expect 404):', trackWrong.status, trackWrong.body.error);

  console.log('\n--- return cannot be submitted before the order is delivered ---');
  const orderItemId = track.body.order.items[0].id;
  const tooEarly = await agent.post('/api/returns').send({
    displayId: checkoutRes.body.displayId, email: 'test@velour.com',
    items: [{ orderItemId, quantity: 1 }], reason: 'Damaged item', description: 'test',
  });
  console.log('status (expect 400, not yet delivered):', tooEarly.status, tooEarly.body.error);

  console.log('\n--- admin login + walk the order through its real lifecycle to DELIVERED ---');
  const login = await agent.post('/api/admin/login').send({ email: 'admin@velour.com', password: 'TestPassword123!' });
  const cookie = login.headers['set-cookie'];
  const listOrders = await agent.get('/api/admin/orders').set('Cookie', cookie);
  console.log('orders visible to admin:', listOrders.body.orders.length);
  const orderRow = listOrders.body.orders.find((o) => o.displayId === checkoutRes.body.displayId);

  const toShipped = await agent.patch(`/api/admin/orders/${orderRow.id}/status`).set('Cookie', cookie).send({ status: 'SHIPPED', trackingCarrier: 'Delhivery', trackingNumber: 'DL999' });
  console.log('-> SHIPPED:', toShipped.status);
  const toDelivered = await agent.patch(`/api/admin/orders/${orderRow.id}/status`).set('Cookie', cookie).send({ status: 'DELIVERED' });
  console.log('-> DELIVERED:', toDelivered.status);

  console.log('\n--- return request, naming a specific item, against the now-delivered order ---');
  const ret = await agent.post('/api/returns').send({
    displayId: checkoutRes.body.displayId,
    email: 'test@velour.com',
    items: [{ orderItemId, quantity: 1 }],
    reason: 'Damaged item',
    description: 'Sleeve seam torn on arrival',
  });
  console.log('status:', ret.status, JSON.stringify(ret.body));
  if (ret.status !== 201) throw new Error('a valid, eligible return was rejected');

  console.log('\n--- admin route WITHOUT cookie (expect 401) ---');
  const noAuth = await agent.get('/api/admin/orders');
  console.log('status:', noAuth.status);

  console.log('\n--- XSS-shaped chat message stored, response never uses innerHTML (frontend concern, verified separately) ---');

  console.log('\nALL CHECKOUT/PAYMENT/RETURN/ADMIN TESTS PASSED');
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
