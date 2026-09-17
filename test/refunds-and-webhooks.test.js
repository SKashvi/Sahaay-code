/* Run with: node test/refunds-and-webhooks.test.js
 * Covers what test/smoke-test.js does not: the actual Razorpay refund call
 * (mocked here, same approach as smoke-test.js), its idempotency, its
 * failure path (must never mark a return REFUNDED without a real refund),
 * and duplicate webhook delivery. */
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
let refundCallCount = 0;
let nextRefundShouldFail = false;

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
      const expected = crypto.createHmac('sha256', 'mock_secret').update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
      return expected === razorpaySignature;
    },
    verifyWebhookSignature: ({ rawBody, signatureHeader }) => {
      const expected = crypto.createHmac('sha256', 'mock_webhook_secret').update(rawBody).digest('hex');
      return expected === signatureHeader;
    },
    refundPayment: async ({ paymentId, amountPaise }) => {
      refundCallCount++;
      if (nextRefundShouldFail) {
        const err = new Error('mock failure');
        err.error = { description: 'The payment has already been fully refunded' };
        throw err;
      }
      return { id: 'rfnd_MOCK' + crypto.randomBytes(4).toString('hex'), amount: amountPaise, payment_id: paymentId };
    },
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');

function mockPaymentSig(orderId, paymentId) {
  return crypto.createHmac('sha256', 'mock_secret').update(`${orderId}|${paymentId}`).digest('hex');
}

async function payAndReturn(agent, email, paymentId, adminCookie) {
  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  const checkout = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: product.sizes[0], color: product.colors[0].name, qty: 1 }],
    customer: { name: 'Refund Test', email, phone: '9876500009', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  await agent.post('/api/orders/verify-payment').send({
    orderId: checkout.body.orderId,
    razorpayOrderId: checkout.body.razorpayOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: mockPaymentSig(checkout.body.razorpayOrderId, paymentId),
  });
  // A return is only eligible once an order is DELIVERED, walk it through
  // the real state machine rather than writing DELIVERED directly, that
  // is the whole point of this test suite exercising real code paths.
  await agent.patch(`/api/admin/orders/${checkout.body.orderId}/status`).set('Cookie', adminCookie).send({ status: 'SHIPPED' });
  await agent.patch(`/api/admin/orders/${checkout.body.orderId}/status`).set('Cookie', adminCookie).send({ status: 'DELIVERED' });

  const track = await agent.post('/api/orders/track').send({ email, displayId: checkout.body.displayId });
  const orderItemId = track.body.order.items[0].id;
  const ret = await agent.post('/api/returns').send({
    displayId: checkout.body.displayId, email, items: [{ orderItemId, quantity: 1 }], reason: 'Damaged item',
  });
  return { checkout, returnDisplayId: ret.body.displayId };
}

async function main() {
  const agent = request(app);
  const login = await agent.post('/api/admin/login').send({ email: 'admin@velour.com', password: 'TestPassword123!' });
  const cookie = login.headers['set-cookie'];
  if (login.status !== 200) throw new Error('admin login failed, run db/seed.js first with a matching ADMIN_EMAIL/ADMIN_PASSWORD');

  console.log('--- refunding a SUBMITTED return must be rejected ---');
  const { checkout: submittedCheckout, returnDisplayId } = await payAndReturn(agent, 'refund-success@velour.com', 'pay_SUCCESS1', cookie);
  let list = await agent.get('/api/admin/returns').set('Cookie', cookie);
  let row = list.body.returns.find((r) => r.displayId === returnDisplayId);
  const submittedRefund = await agent.post(`/api/admin/returns/${row.id}/refund`).set('Cookie', cookie);
  console.log('submitted refund status (expect 400):', submittedRefund.status, submittedRefund.body.error);
  if (submittedRefund.status !== 400) throw new Error('CRITICAL: a SUBMITTED return was refundable before approval');

  const approved = await agent.patch(`/api/admin/returns/${row.id}/status`).set('Cookie', cookie).send({ status: 'APPROVED' });
  if (approved.status !== 200) throw new Error('could not approve return before refund test');

  console.log('--- successful refund ---');
  list = await agent.get('/api/admin/returns').set('Cookie', cookie);
  row = list.body.returns.find((r) => r.displayId === returnDisplayId);
  const refundRes = await agent.post(`/api/admin/returns/${row.id}/refund`).set('Cookie', cookie);
  console.log('refund result:', refundRes.status, refundRes.body.razorpayRefundId ? 'got a refund id' : 'MISSING refund id');
  if (refundRes.status !== 200 || !refundRes.body.razorpayRefundId) throw new Error('refund did not succeed as expected');

  console.log('\n--- refunding the same return again must not call Razorpay a second time ---');
  const callsBefore = refundCallCount;
  const refundAgain = await agent.post(`/api/admin/returns/${row.id}/refund`).set('Cookie', cookie);
  console.log('second call result:', refundAgain.status, refundAgain.body.alreadyRefunded);
  if (refundCallCount !== callsBefore) throw new Error('refund was NOT idempotent, Razorpay was called twice for one return');

  console.log('\n--- direct PATCH cannot set REFUNDED, only the real refund endpoint can ---');
  const directSet = await agent.patch(`/api/admin/returns/${row.id}/status`).set('Cookie', cookie).send({ status: 'REFUNDED' });
  console.log('status (expect 400, REFUNDED is not in the allowed enum):', directSet.status);
  if (directSet.status !== 400) throw new Error('REFUNDED should not be directly settable');

  console.log('\n--- a failing Razorpay refund must not mark the return REFUNDED ---');
  nextRefundShouldFail = true;
  const { returnDisplayId: failDisplayId } = await payAndReturn(agent, 'refund-fail@velour.com', 'pay_FAIL1', cookie);
  list = await agent.get('/api/admin/returns').set('Cookie', cookie);
  const failRow = list.body.returns.find((r) => r.displayId === failDisplayId);
  const failedRefund = await agent.post(`/api/admin/returns/${failRow.id}/refund`).set('Cookie', cookie);
  console.log('refund attempt status (expect 502):', failedRefund.status);
  const listAfterFail = await agent.get('/api/admin/returns').set('Cookie', cookie);
  const rowAfterFail = listAfterFail.body.returns.find((r) => r.displayId === failDisplayId);
  console.log('return status after a FAILED refund (must not be REFUNDED):', rowAfterFail.status, 'error recorded:', rowAfterFail.refundError);
  if (rowAfterFail.status === 'REFUNDED') throw new Error('CRITICAL: a failed refund was recorded as REFUNDED, this is a real money bug');
  nextRefundShouldFail = false;

  console.log('\n--- return photoUrl must come from our own upload endpoint, not an arbitrary URL ---');
  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  const checkout2 = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: product.sizes[0], color: product.colors[0].name, qty: 1 }],
    customer: { name: 'Photo Test', email: 'phototrust@velour.com', phone: '9876500010', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  // A fake order item id is fine here, the photoUrl check runs before the
  // route ever looks at items, this test is specifically about that check
  // firing first and rejecting before anything else is even considered.
  const badPhoto = await agent.post('/api/returns').send({
    displayId: checkout2.body.displayId, email: 'phototrust@velour.com',
    items: [{ orderItemId: crypto.randomUUID(), quantity: 1 }],
    reason: 'Damaged item', photoUrl: 'https://evil.example.com/x.jpg',
  });
  console.log('status (expect 400):', badPhoto.status, badPhoto.body.error);
  if (badPhoto.status !== 400) throw new Error('an arbitrary external photoUrl was accepted, this should be rejected');

  console.log('\n--- webhook delivered twice for the same event must only be processed once ---');
  const payload = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: 'pay_WEBHOOKDEDUPE', order_id: 'order_DOESNOTMATTER' } } } });
  const wsig = crypto.createHmac('sha256', 'mock_webhook_secret').update(payload).digest('hex');
  const w1 = await agent.post('/api/payments/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', wsig).send(payload);
  const w2 = await agent.post('/api/payments/razorpay/webhook').set('Content-Type', 'application/json').set('X-Razorpay-Signature', wsig).send(payload);
  console.log('first delivery:', w1.status, JSON.stringify(w1.body));
  console.log('second delivery (expect duplicate true):', w2.status, JSON.stringify(w2.body));
  if (!w2.body.duplicate) throw new Error('duplicate webhook delivery was processed a second time');

  console.log('\nALL REFUND AND WEBHOOK REGRESSION TESTS PASSED');
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
