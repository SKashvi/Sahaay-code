/* Run with: node test/inventory-concurrency.test.js
 * Sets a variant's stock to exactly 1, then fires two checkout requests
 * for that same variant at the same time. A sequential test proves
 * nothing here, only a genuine race does. Exactly one must succeed, the
 * other must see the stock gone and fail cleanly, and the variant's final
 * stock must be exactly 0, never negative. */
require('dotenv').config();
const crypto = require('crypto');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath,
  filename: razorpayPath,
  loaded: true,
  exports: {
    razorpay: {},
    createRazorpayOrder: async ({ amountPaise, receipt }) => {
      // A small delay widens the race window so this test reliably
      // exercises the race instead of getting lucky on timing.
      await new Promise((r) => setTimeout(r, 100));
      return { id: 'order_MOCK' + crypto.randomBytes(4).toString('hex'), amount: amountPaise, receipt };
    },
    verifyPaymentSignature: () => true,
    verifyWebhookSignature: () => true,
    refundPayment: async () => ({ id: 'rfnd_MOCK', amount: 0 }),
  },
};

const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');

async function main() {
  const agent = request(app);

  const productsRes = await agent.get('/api/products');
  const product = productsRes.body.products[0];
  const size = product.sizes[0];
  const color = product.colors[0].name;

  const variantRow = await db.query(
    'SELECT id, stock_quantity, reserved_quantity FROM product_variants WHERE product_id = $1 AND size = $2 AND color = $3',
    [product.id, size, color]
  );
  const variantId = variantRow.rows[0].id;
  console.log('starting stock for this variant:', variantRow.rows[0].stock_quantity);

  await db.query('UPDATE product_variants SET stock_quantity = 1, reserved_quantity = 0 WHERE id = $1', [variantId]);
  console.log('forced stock to exactly 1 for this test');

  const buildPayload = () => ({
    idempotencyKey: crypto.randomUUID(), // deliberately DIFFERENT keys, these are two different customers/attempts, not a retry
    items: [{ productId: product.id, size, color, qty: 1 }],
    customer: { name: 'Race Buyer', email: 'race-' + crypto.randomBytes(3).toString('hex') + '@velour.com', phone: '9876500099', address: 'x', city: 'Lucknow', state: 'UP', pincode: '226001' },
  });

  console.log('\n--- two simultaneous checkouts for the last unit ---');
  const [a, b] = await Promise.all([
    agent.post('/api/orders/checkout').send(buildPayload()),
    agent.post('/api/orders/checkout').send(buildPayload()),
  ]);
  console.log('response A:', a.status, a.body.error || a.body.orderId);
  console.log('response B:', b.status, b.body.error || b.body.orderId);

  const succeeded = [a, b].filter((r) => r.status === 201);
  const failed = [a, b].filter((r) => r.status !== 201);
  console.log('successful checkouts (must be exactly 1):', succeeded.length);
  console.log('failed checkouts (must be exactly 1, with a clear out-of-stock message):', failed.length, failed[0] && failed[0].body.error);

  if (succeeded.length !== 1) {
    throw new Error(`CRITICAL: ${succeeded.length} checkouts succeeded for one unit of stock, this is overselling`);
  }
  if (failed.length !== 1 || failed[0].status !== 409) {
    throw new Error('expected exactly one failure with a 409 out-of-stock response');
  }

  const finalStock = await db.query('SELECT stock_quantity FROM product_variants WHERE id = $1', [variantId]);
  console.log('final stock (must be exactly 0, never negative):', finalStock.rows[0].stock_quantity);
  if (finalStock.rows[0].stock_quantity !== 0) {
    throw new Error(`CRITICAL: final stock is ${finalStock.rows[0].stock_quantity}, expected exactly 0`);
  }

  console.log('\n--- a third attempt after the stock is gone is rejected cleanly, not a crash ---');
  const thirdAttempt = await agent.post('/api/orders/checkout').send(buildPayload());
  console.log('status (expect 409):', thirdAttempt.status, thirdAttempt.body.error);
  if (thirdAttempt.status !== 409) throw new Error('checkout against zero stock should fail cleanly with 409');

  // Restore a normal stock level so this variant is not left at 0 for
  // whoever runs the rest of the suite after this file.
  await db.query('UPDATE product_variants SET stock_quantity = 20, reserved_quantity = 0 WHERE id = $1', [variantId]);

  console.log('\nPASS: a genuine concurrent purchase of the final unit cannot oversell');
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
