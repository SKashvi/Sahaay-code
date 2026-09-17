/* Run with: node test/order-cancellation.test.js
 *
 * Customer-initiated cancellation, against a real database.
 *
 * Three things have to hold:
 *   1. An order being PROCESSED can still be cancelled.
 *   2. An order that has SHIPPED cannot, and the refusal points at returns.
 *   3. Cancelling gives the inventory back. This is the one that goes wrong
 *      quietly: a paid order's reservation was already finalized, so the units
 *      are gone from stock_quantity outright and nothing un-reserves them.
 *
 * Also checks that cancelling a PAID order files a refund request that is
 * SUBMITTED rather than APPROVED, because the human approval gate in
 * src/lib/refunds.js is the whole reason the refund is not just sent.
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
      id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'),
      amount: amountPaise,
      receipt,
    }),
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => true,
    refundPayment: async () => ({ id: 'rfnd_MOCK', amount: 0 }),
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');
const { cancelOrder, isCancellable, CancellationError } = require('../src/lib/cancellation');

const agent = request(app);

/* Places a real order through the real checkout, so the test exercises the
 * same rows production writes rather than a hand-built fixture. */
async function placeOrder() {
  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  const size = product.sizes[0];
  const color = product.colors[0].name;

  const variantRow = await db.query(
    'SELECT id, stock_quantity FROM product_variants WHERE product_id = $1 AND size = $2 AND color = $3',
    [product.id, size, color]
  );
  const variant = variantRow.rows[0];
  // Enough stock that the checkout below cannot fail for an unrelated reason.
  await db.query('UPDATE product_variants SET stock_quantity = 25, reserved_quantity = 0 WHERE id = $1', [variant.id]);

  const email = `cancel-test-${crypto.randomBytes(4).toString('hex')}@example.test`;
  const res = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size, color, qty: 2 }],
    customer: {
      name: 'Cancel Test', email, phone: '9999999999',
      address: '1 Test Street', city: 'Mumbai', state: 'MH', pincode: '400001',
    },
  });
  assert.strictEqual(res.status, 201, `checkout failed: ${JSON.stringify(res.body)}`);
  return { orderId: res.body.orderId, displayId: res.body.displayId, email, variantId: variant.id, qty: 2 };
}

async function stockOf(variantId) {
  const row = await db.query('SELECT stock_quantity AS stock, reserved_quantity AS reserved FROM product_variants WHERE id = $1', [variantId]);
  return { stock: row.rows[0].stock, reserved: row.rows[0].reserved };
}

async function markPaid(orderId) {
  // The same move verify-payment makes: PROCESSING, a payment id on the row,
  // and the reservation finalized so the units leave stock for good.
  const { finalizeReservation } = require('../src/lib/inventoryReservations');
  await db.withTransaction(async (client) => {
    await client.query(
      `UPDATE orders SET status = 'PROCESSING', razorpay_payment_id = $1, paid_at = now(), updated_at = now() WHERE id = $2`,
      ['pay_MOCK' + crypto.randomBytes(4).toString('hex'), orderId]
    );
    await finalizeReservation(client, orderId);
  });
}

async function testCancelAllowedWhileProcessing() {
  const order = await placeOrder();
  await markPaid(order.orderId);

  const before = await stockOf(order.variantId);
  const outcome = await cancelOrder(order.orderId);

  assert.strictEqual(outcome.order.status, 'CANCELLED', 'a PROCESSING order must be cancellable');
  assert.ok(outcome.order.cancelled_at, 'cancelled_at must be stamped');

  // The refund is filed, not made. SUBMITTED is what keeps it behind the
  // human approval gate: src/lib/refunds.js refuses anything not APPROVED.
  assert.ok(outcome.refund, 'a paid order must produce a refund request');
  const refundRow = await db.query(
    `SELECT kind, status, refund_amount AS "refundAmount", razorpay_refund_id AS "razorpayRefundId"
       FROM return_requests WHERE order_id = $1`,
    [order.orderId]
  );
  assert.strictEqual(refundRow.rows.length, 1, 'exactly one refund request');
  assert.strictEqual(refundRow.rows[0].kind, 'CANCELLATION', 'filed as a cancellation, not a return');
  assert.strictEqual(refundRow.rows[0].status, 'SUBMITTED', 'must await human approval, never start APPROVED');
  assert.strictEqual(refundRow.rows[0].razorpayRefundId, null, 'no money may have moved');

  const after = await stockOf(order.variantId);
  assert.strictEqual(after.stock, before.stock + order.qty, 'stock must come back when a paid order is cancelled');
  console.log('  ok  a PROCESSING order cancels, files a refund for review, and returns its stock');
}

async function testCancelRefusedAfterShipped() {
  const order = await placeOrder();
  await markPaid(order.orderId);
  const { transitionOrder } = require('../src/lib/orderStateMachine');
  await transitionOrder(order.orderId, 'SHIPPED');

  const before = await stockOf(order.variantId);
  await assert.rejects(
    () => cancelOrder(order.orderId),
    (err) => {
      assert.ok(err instanceof CancellationError, 'must be a CancellationError, not a raw state machine error');
      assert.match(err.message, /shipped/i, 'must say why');
      // Mirrors how src/lib/returns.js refuses a return before delivery: name
      // the state, then point at the route that does apply.
      assert.match(err.message, /return/i, 'must point the customer at returns');
      return true;
    }
  );

  const row = await db.query('SELECT status FROM orders WHERE id = $1', [order.orderId]);
  assert.strictEqual(row.rows[0].status, 'SHIPPED', 'a refused cancel must leave the order alone');
  const after = await stockOf(order.variantId);
  assert.strictEqual(after.stock, before.stock, 'a refused cancel must not touch stock');
  const refunds = await db.query('SELECT id FROM return_requests WHERE order_id = $1', [order.orderId]);
  assert.strictEqual(refunds.rows.length, 0, 'a refused cancel must not file a refund');
  console.log('  ok  a SHIPPED order refuses to cancel and points at returns');
}

async function testUnpaidCancelReleasesReservation() {
  // Never paid, so the units are still held in reserved_quantity and the
  // repair is the other one: release the hold rather than add stock back.
  const order = await placeOrder();
  const before = await stockOf(order.variantId);
  assert.ok(before.reserved >= order.qty, 'an unpaid order should be holding its units');

  const outcome = await cancelOrder(order.orderId);
  assert.strictEqual(outcome.order.status, 'CANCELLED');
  assert.strictEqual(outcome.refund, null, 'nothing was charged, so nothing is refundable');

  const after = await stockOf(order.variantId);
  assert.strictEqual(after.stock, before.stock + order.qty, 'stock returns');
  assert.strictEqual(after.reserved, before.reserved - order.qty, 'the hold is released');
  console.log('  ok  an unpaid order cancels, releases its hold, and owes no refund');
}

async function testDoubleCancelIsRefused() {
  const order = await placeOrder();
  await cancelOrder(order.orderId);
  const before = await stockOf(order.variantId);

  await assert.rejects(() => cancelOrder(order.orderId), /already been cancelled/i);

  const after = await stockOf(order.variantId);
  assert.strictEqual(after.stock, before.stock, 'a second cancel must not return the stock twice');
  console.log('  ok  cancelling twice is refused and does not double-credit stock');
}

async function testCancellableHelperMatchesTheStatuses() {
  assert.strictEqual(isCancellable({ status: 'PENDING_PAYMENT' }), true);
  assert.strictEqual(isCancellable({ status: 'PROCESSING' }), true);
  assert.strictEqual(isCancellable({ status: 'SHIPPED' }), false);
  assert.strictEqual(isCancellable({ status: 'OUT_FOR_DELIVERY' }), false);
  assert.strictEqual(isCancellable({ status: 'DELIVERED' }), false);
  assert.strictEqual(isCancellable({ status: 'CANCELLED' }), false);
  console.log('  ok  canCancel matches the statuses that already exist in 001_initial.sql');
}

async function testHttpCancelRefusesAWrongEmail() {
  const order = await placeOrder();
  const res = await agent.post('/api/orders/cancel').send({
    email: 'someone-else@example.test',
    displayId: order.displayId,
  });
  assert.strictEqual(res.status, 404, 'a mismatched email must not cancel someone else\'s order');
  const row = await db.query('SELECT status FROM orders WHERE id = $1', [order.orderId]);
  assert.notStrictEqual(row.rows[0].status, 'CANCELLED');
  console.log('  ok  POST /api/orders/cancel refuses an email that does not own the order');
}

async function main() {
  console.log('order cancellation');
  await testCancellableHelperMatchesTheStatuses();
  await testCancelAllowedWhileProcessing();
  await testCancelRefusedAfterShipped();
  await testUnpaidCancelReleasesReservation();
  await testDoubleCancelIsRefused();
  await testHttpCancelRefusesAWrongEmail();
  console.log('\nAll order cancellation tests passed.');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
