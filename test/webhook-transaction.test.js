/* Run with: node test/webhook-transaction.test.js
 * Regression test for a real bug from an earlier pass: the dedupe INSERT
 * and the business UPDATE used to be two separate, un-transacted queries.
 * If the UPDATE ever threw after the dedupe row committed, a legitimate
 * Razorpay retry would see "already processed" and the payment
 * confirmation would be lost for good. This forces that failure through
 * the real route (not just the underlying db helper) by making the pg
 * Pool hand out a client whose query() rejects on the specific UPDATE, and
 * confirms a subsequent retry of the identical webhook is NOT treated as
 * a duplicate and is genuinely reprocessed. */
require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/lib/db');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath,
  filename: razorpayPath,
  loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async () => ({ id: 'order_MOCK' }),
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: ({ rawBody, signatureHeader }) => {
      const expected = crypto.createHmac('sha256', 'mock_webhook_secret').update(rawBody).digest('hex');
      return expected === signatureHeader;
    },
    refundPayment: async () => ({ id: 'rfnd_MOCK', amount: 0 }),
  },
};

const request = require('supertest');
const app = require('../src/app');

async function main() {
  const agent = request(app);
  const payload = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_TXNTEST' + crypto.randomBytes(3).toString('hex'), order_id: 'order_TXNTEST' } } },
  });
  const sig = crypto.createHmac('sha256', 'mock_webhook_secret').update(payload).digest('hex');

  // Make exactly one UPDATE statement fail, by wrapping the real pool's
  // connect() to hand back a client whose query() rejects the first time
  // it sees the business-update SQL, then behaves normally after that.
  const originalConnect = db.pool.connect.bind(db.pool);
  let shouldFailNext = true;
  db.pool.connect = async function () {
    const client = await originalConnect();
    const originalQuery = client.query.bind(client);
    client.query = function (text, params) {
      if (shouldFailNext && typeof text === 'string' && text.includes("UPDATE orders SET status = 'PROCESSING'")) {
        shouldFailNext = false;
        return Promise.reject(new Error('simulated transient failure during business update'));
      }
      return originalQuery(text, params);
    };
    return client;
  };

  const first = await agent.post('/api/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .send(payload);
  console.log('first delivery, business update forced to fail:', first.status, JSON.stringify(first.body));
  if (first.status < 500) throw new Error('expected the forced failure to surface as an error response, not a silent success');

  db.pool.connect = originalConnect; // restore normal behavior for the retry

  const retry = await agent.post('/api/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .send(payload);
  console.log('retry delivery, should actually process, not be swallowed as a duplicate:', retry.status, JSON.stringify(retry.body));
  if (retry.status !== 200 || retry.body.duplicate !== false) {
    throw new Error('CRITICAL: the retry was treated as a duplicate, the failed first attempt permanently ate this event');
  }

  const secondRetry = await agent.post('/api/payments/razorpay/webhook')
    .set('Content-Type', 'application/json')
    .set('X-Razorpay-Signature', sig)
    .send(payload);
  console.log('a genuine second delivery of the now-successfully-processed event IS a duplicate:', secondRetry.status, JSON.stringify(secondRetry.body));
  if (secondRetry.body.duplicate !== true) throw new Error('a real duplicate delivery after success was not detected as one');

  console.log('\nPASS: a failed webhook business update rolls back cleanly and a retry genuinely reprocesses it');
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
