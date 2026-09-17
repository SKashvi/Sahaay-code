/* Run with: node test/refund-concurrency.test.js
 * A sequential "call refund, wait for it to finish, call refund again"
 * test proves nothing about a real race, both calls only ever compete
 * against a fully-committed prior state. This fires two refund requests
 * for the SAME return at the same time, with Promise.all, and proves only
 * one of them ever actually reaches Razorpay. The other must see the row
 * already claimed (REFUND_PENDING) and back off with a conflict, it must
 * NOT also call the payment gateway. */
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
let refundCallCount = 0;
// A small delay inside the mocked Razorpay call widens the race window,
// making this test reliably catch a regression instead of getting lucky.
require.cache[razorpayPath] = {
  id: razorpayPath,
  filename: razorpayPath,
  loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async ({ amountPaise, receipt }) => ({ id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'), amount: amountPaise, receipt }),
    verifyPaymentSignature: ({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) => {
      const expected = crypto.createHmac('sha256', 'mock_secret').update(`${razorpayOrderId}|${razorpayPaymentId}`).digest('hex');
      return expected === razorpaySignature;
    },
    verifyWebhookSignature: () => true,
    refundPayment: async ({ paymentId, amountPaise }) => {
      refundCallCount++;
      await new Promise((r) => setTimeout(r, 150));
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

async function main() {
  const agent = request(app);
  const login = await agent.post('/api/admin/login').send({ email: 'admin@velour.com', password: 'TestPassword123!' });
  const cookie = login.headers['set-cookie'];
  if (login.status !== 200) throw new Error('admin login failed, run db/seed.js first');

  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  const email = 'concurrency-test@velour.com';
  const checkout = await agent.post('/api/orders/checkout').send({
    idempotencyKey: crypto.randomUUID(),
    items: [{ productId: product.id, size: product.sizes[0], color: product.colors[0].name, qty: 1 }],
    customer: { name: 'Concurrency Test', email, phone: '9876500011', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });
  const paymentId = 'pay_CONCURRENCY1';
  await agent.post('/api/orders/verify-payment').send({
    orderId: checkout.body.orderId,
    razorpayOrderId: checkout.body.razorpayOrderId,
    razorpayPaymentId: paymentId,
    razorpaySignature: mockPaymentSig(checkout.body.razorpayOrderId, paymentId),
  });
  await agent.patch(`/api/admin/orders/${checkout.body.orderId}/status`).set('Cookie', cookie).send({ status: 'SHIPPED' });
  await agent.patch(`/api/admin/orders/${checkout.body.orderId}/status`).set('Cookie', cookie).send({ status: 'DELIVERED' });

  const track = await agent.post('/api/orders/track').send({ email, displayId: checkout.body.displayId });
  const orderItemId = track.body.order.items[0].id;
  const ret = await agent.post('/api/returns').send({
    displayId: checkout.body.displayId, email, items: [{ orderItemId, quantity: 1 }], reason: 'Damaged item',
  });

  const list = await agent.get('/api/admin/returns').set('Cookie', cookie);
  const row = list.body.returns.find((r) => r.displayId === ret.body.displayId);
  await agent.patch(`/api/admin/returns/${row.id}/status`).set('Cookie', cookie).send({ status: 'APPROVED' });
  

  console.log('--- firing two refund requests for the SAME return at the same time ---');
  const [a, b] = await Promise.all([
    agent.post(`/api/admin/returns/${row.id}/refund`).set('Cookie', cookie),
    agent.post(`/api/admin/returns/${row.id}/refund`).set('Cookie', cookie),
  ]);
  console.log('response A:', a.status, JSON.stringify(a.body));
  console.log('response B:', b.status, JSON.stringify(b.body));
  console.log('actual Razorpay refund calls made (must be exactly 1):', refundCallCount);

  if (refundCallCount !== 1) {
    throw new Error(`CRITICAL: Razorpay was called ${refundCallCount} times for one return, this double-refunds a real customer`);
  }
  const outcomes = [a.status, b.status].sort();
  const oneSucceeded = a.body.razorpayRefundId || b.body.razorpayRefundId;
  const otherConflicted = a.status === 409 || b.status === 409;
  console.log('exactly one side got the refund result, the other got a 409 conflict:', Boolean(oneSucceeded && otherConflicted));
  if (!oneSucceeded || !otherConflicted) {
    throw new Error('expected one 200 with a refund id and one 409 conflict, got: ' + JSON.stringify(outcomes));
  }

  const finalCheck = await agent.get('/api/admin/returns').set('Cookie', cookie);
  const finalRow = finalCheck.body.returns.find((r) => r.displayId === ret.body.displayId);
  console.log('final state (expect REFUNDED, exactly one refund id):', finalRow.status, finalRow.razorpayRefundId);
  if (finalRow.status !== 'REFUNDED') throw new Error('return did not end up in a clean REFUNDED state after the race');

  console.log('\nPASS: a genuine concurrent refund race results in exactly one Razorpay refund call');
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
