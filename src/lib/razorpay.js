const crypto = require('crypto');
const Razorpay = require('razorpay');
const { env } = require('../config/env');

const razorpay = new Razorpay({
  key_id: env.RAZORPAY_KEY_ID,
  key_secret: env.RAZORPAY_KEY_SECRET,
});

/** Creates a Razorpay order for the given amount (in paise). Amount must
 * already be the server-calculated total, never a value trusted from the
 * client, see orders route for where that calculation happens. */
async function createRazorpayOrder({ amountPaise, receipt }) {
  return razorpay.orders.create({
    amount: amountPaise,
    currency: 'INR',
    receipt,
  });
}

/** Issues a real refund against a captured payment. `notes.returnDisplayId`
 * gets attached to the refund on Razorpay's side purely so a human looking
 * at the Razorpay dashboard can trace it back to the return request that
 * caused it, it has no effect on this app's own logic. This function does
 * not attempt to be idempotent on its own, the caller (routes/admin.js)
 * is responsible for checking whether a return was already refunded
 * before calling this at all, never assume any payment gateway API
 * dedupes retries for you unless its documentation explicitly says so. */
async function refundPayment({ paymentId, amountPaise, receipt, returnDisplayId, idempotencyKey }) {
  const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64');
  const response = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'X-Refund-Idempotency': idempotencyKey } : {}),
    },
    body: JSON.stringify({ amount: amountPaise, receipt, notes: { returnDisplayId: returnDisplayId || '' } }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body?.error?.description || `Razorpay refund failed with ${response.status}`);
    err.status = response.status;
    err.error = body?.error;
    throw err;
  }
  return body;
}

/** Verifies the signature Razorpay Checkout returns to the browser after a
 * successful payment. This must pass before an order is ever marked paid. */
function verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }) {
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_KEY_SECRET)
    .update(`${razorpayOrderId}|${razorpayPaymentId}`)
    .digest('hex');
  return timingSafeEqual(expected, razorpaySignature);
}

/** Verifies the X-Razorpay-Signature header on incoming webhook calls
 * against the raw request body, using the separate webhook secret
 * configured in the Razorpay dashboard. Never trust a webhook body without
 * this check, it is the only thing standing between this endpoint and
 * anyone on the internet who wants to fake a "payment succeeded" event. */
function verifyWebhookSignature({ rawBody, signatureHeader }) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  const expected = crypto
    .createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqual(expected, signatureHeader || '');
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { razorpay, createRazorpayOrder, refundPayment, verifyPaymentSignature, verifyWebhookSignature };
