/* Run with: node test/verified-order-panel.test.js
 *
 * A verified customer reading their own order must never touch the model.
 *
 * "Show order status" used to post a chat message and wait for the agent to
 * decide to call get_order_status, which put a language model, its rate limit
 * and its bill between a verified customer and a row they had already proved
 * they can read. These endpoints do it as one database call.
 *
 * Covered here:
 *   - /api/orders/mine returns the order for the verified session only, and
 *     needs the signed cookie, not just a session id anyone can type.
 *   - the view carries everything the panel's buttons are drawn from, and its
 *     flags agree with what the cancel endpoint will actually allow.
 *   - /api/orders/mine/cancel cancels through the same path the tracking page
 *     and the agent tool use, and refuses once shipped.
 *   - the chat route flags a model outage so the widget can show the panel
 *     rather than an apology.
 */
require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath,
  filename: razorpayPath,
  loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async ({ amountPaise, receipt }) => ({
      id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'), amount: amountPaise, receipt,
    }),
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => true,
    refundPayment: async () => ({ id: 'rfnd_MOCK', amount: 0 }),
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');
const { signCustomerToken } = require('../src/lib/auth');

const agent = request(app);

async function placeOrder() {
  const products = (await agent.get('/api/products')).body.products;
  const product = products[0];
  const size = product.sizes[0];
  const color = product.colors[0].name;

  const variant = await db.query(
    'SELECT id FROM product_variants WHERE product_id = $1 AND size = $2 AND color = $3',
    [product.id, size, color]
  );
  await db.query('UPDATE product_variants SET stock_quantity = 25, reserved_quantity = 0 WHERE id = $1', [variant.rows[0].id]);

  const email = `panel-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const res = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size, color, qty: 2 }],
    customer: {
      name: 'Panel Test', email, phone: '9999999999',
      address: '1 Test Street', city: 'Mumbai', state: 'MH', pincode: '400001',
    },
  });
  assert.strictEqual(res.status, 201, `checkout failed: ${JSON.stringify(res.body)}`);
  return { orderId: res.body.orderId, displayId: res.body.displayId, email };
}

/* The cookie the widget gets after verifying a code. Minted directly here so
 * the test does not need a mail round trip; it is the same token the verify
 * route signs. */
function verifiedCookie(order, sessionId) {
  const token = signCustomerToken({
    sessionId,
    email: order.email,
    orderId: order.orderId,
    orderDisplayId: order.displayId,
  });
  return `customer_session=${token}`;
}

async function testMineNeedsTheCookieNotJustASessionId() {
  const order = await placeOrder();
  const sessionId = crypto.randomUUID();

  // No cookie at all: a session id is browser-supplied and proves nothing.
  const anonymous = await agent.post('/api/orders/mine').send({ sessionId });
  assert.strictEqual(anonymous.status, 401, 'an unverified session must get nothing');
  assert.strictEqual(anonymous.body.error, 'not_verified');

  // A real cookie, but for a different session id than the body claims.
  const mismatched = await agent.post('/api/orders/mine')
    .set('Cookie', verifiedCookie(order, crypto.randomUUID()))
    .send({ sessionId });
  assert.strictEqual(mismatched.status, 401, 'the cookie and the session id must agree');

  console.log('  ok  /api/orders/mine needs the signed cookie, not just a session id');
}

async function testMineReturnsTheOrderWithEverythingThePanelDraws() {
  const order = await placeOrder();
  const sessionId = crypto.randomUUID();
  const res = await agent.post('/api/orders/mine')
    .set('Cookie', verifiedCookie(order, sessionId))
    .send({ sessionId });

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.orders.length, 1);
  const view = res.body.orders[0];

  assert.strictEqual(view.displayId, order.displayId);
  assert.strictEqual(view.status, 'PENDING_PAYMENT');
  assert.strictEqual(view.statusLabel, 'Payment pending', 'the panel shows a label, not a raw enum');
  assert.ok(Array.isArray(view.items) && view.items.length === 1, 'line items');
  assert.ok(view.items[0].itemId, 'items must carry ids, the return form posts them');
  assert.ok(view.total, 'a formatted total');

  // The progress steps, matching the storefront's tracking page.
  assert.deepStrictEqual(view.stages, ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
  assert.strictEqual(view.stageIndex, 0, 'a new order sits on the first step');
  assert.strictEqual(view.stageLabels.DELIVERED, 'Delivered');

  // What the buttons are drawn from.
  assert.strictEqual(view.canCancel, true, 'an unpaid order is cancellable');
  assert.strictEqual(view.canRequestReturn, false, 'nothing to return before delivery');
  console.log('  ok  the view carries the steps, items and action flags the panel needs');
}

async function testCancelThroughTheVerifiedSession() {
  const order = await placeOrder();
  const sessionId = crypto.randomUUID();
  const cookie = verifiedCookie(order, sessionId);

  const before = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId });
  assert.strictEqual(before.body.orders[0].canCancel, true);

  const cancel = await agent.post('/api/orders/mine/cancel').set('Cookie', cookie).send({ sessionId });
  assert.strictEqual(cancel.status, 200, JSON.stringify(cancel.body));
  assert.strictEqual(cancel.body.status, 'CANCELLED');
  assert.strictEqual(cancel.body.refundRequested, false, 'nothing was charged');

  // The panel re-reads, and the flags it draws from must have moved with it.
  const after = await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId });
  const view = after.body.orders[0];
  assert.strictEqual(view.status, 'CANCELLED');
  assert.strictEqual(view.canCancel, false, 'the Cancel button must disappear');
  assert.strictEqual(view.stageIndex, -1, 'cancelled is not a step along the track');
  assert.strictEqual(view.statusLabel, 'Cancelled');
  console.log('  ok  the panel cancels through the verified session and the flags follow');
}

async function testCancelRefusedOnceShipped() {
  const order = await placeOrder();
  const sessionId = crypto.randomUUID();
  const cookie = verifiedCookie(order, sessionId);

  const { finalizeReservation } = require('../src/lib/inventoryReservations');
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE orders SET status = 'PROCESSING', razorpay_payment_id = $1, paid_at = now() WHERE id = $2`,
      ['pay_MOCK' + crypto.randomBytes(4).toString('hex'), order.orderId]
    );
    await finalizeReservation(client, order.orderId);
  });
  const { transitionOrder } = require('../src/lib/orderStateMachine');
  await transitionOrder(order.orderId, 'SHIPPED');

  const view = (await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId })).body.orders[0];
  assert.strictEqual(view.canCancel, false, 'the panel must not offer a button the API will refuse');
  assert.strictEqual(view.stageIndex, 2, 'shipped is the third step');

  // And the endpoint refuses regardless of what a stale panel thought.
  const cancel = await agent.post('/api/orders/mine/cancel').set('Cookie', cookie).send({ sessionId });
  assert.strictEqual(cancel.status, 400, 'a shipped order cannot be cancelled');
  assert.match(cancel.body.error, /shipped/i);
  assert.match(cancel.body.error, /return/i, 'and it points at returns');
  console.log('  ok  a shipped order hides the button and the endpoint refuses anyway');
}

async function testDeliveredOrderOffersAReturn() {
  const order = await placeOrder();
  const sessionId = crypto.randomUUID();
  const cookie = verifiedCookie(order, sessionId);

  const { finalizeReservation } = require('../src/lib/inventoryReservations');
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE orders SET status = 'PROCESSING', razorpay_payment_id = $1, paid_at = now() WHERE id = $2`,
      ['pay_MOCK' + crypto.randomBytes(4).toString('hex'), order.orderId]
    );
    await finalizeReservation(client, order.orderId);
  });
  const { transitionOrder } = require('../src/lib/orderStateMachine');
  await transitionOrder(order.orderId, 'SHIPPED');
  await transitionOrder(order.orderId, 'DELIVERED');

  const view = (await agent.post('/api/orders/mine').set('Cookie', cookie).send({ sessionId })).body.orders[0];
  assert.strictEqual(view.canRequestReturn, true, 'a freshly delivered order can be returned');
  assert.strictEqual(view.canCancel, false, 'and can no longer be cancelled');
  assert.strictEqual(view.stageIndex, 4, 'delivered is the last step');

  // The return the panel's form posts, straight to the same endpoint the
  // tracking page uses. No chat, no model.
  const submitted = await agent.post('/api/returns').send({
    displayId: order.displayId,
    email: order.email,
    items: [{ orderItemId: view.items[0].itemId, quantity: 1 }],
    reason: 'Wrong size',
    description: '',
  });
  assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
  assert.ok(submitted.body.displayId, 'a request id to show the customer');
  console.log('  ok  a delivered order offers a return, and the form posts straight to /api/returns');
}

async function testChatFlagsAModelOutage() {
  // The widget turns this flag into the orders panel for a verified customer,
  // instead of an apology. Matching on the apology's wording would break the
  // moment someone rewords it, so the flag is what carries the meaning.
  const ai = require('../src/lib/ai');
  const chatRoute = require('../src/routes/chat');
  assert.ok(chatRoute, 'chat route loads');

  const src = require('fs').readFileSync(require.resolve('../src/lib/ai'), 'utf8');
  assert.match(src, /degraded: true/, 'ai.js must flag an unreachable model');
  const routeSrc = require('fs').readFileSync(require.resolve('../src/routes/chat'), 'utf8');
  assert.match(routeSrc, /degraded: Boolean\(outcome\.degraded\)/, 'the chat route must pass the flag through');
  assert.strictEqual(typeof ai.replyTo, 'function');
  console.log('  ok  a model outage is flagged to the client, not just worded differently');
}

async function main() {
  console.log('verified order panel');
  await testMineNeedsTheCookieNotJustASessionId();
  await testMineReturnsTheOrderWithEverythingThePanelDraws();
  await testCancelThroughTheVerifiedSession();
  await testCancelRefusedOnceShipped();
  await testDeliveredOrderOffersAReturn();
  await testChatFlagsAModelOutage();
  console.log('\nAll verified order panel tests passed.');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
