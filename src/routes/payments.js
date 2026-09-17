const express = require('express');
const db = require('../lib/db');
const { verifyWebhookSignature } = require('../lib/razorpay');
const { notifyOrderConfirmed } = require('../lib/notifications');
const { finalizeReservation, releaseReservation } = require('../lib/inventoryReservations');

const router = express.Router();

/**
 * This route is mounted with express.raw() in app.js, not express.json(),
 * because the signature has to be computed over the exact bytes Razorpay
 * sent. Parsing to JSON first and re-serializing would change the bytes
 * and the signature would never match, so verification would either always
 * fail (safe but useless) or, if someone "fixed" that by skipping
 * verification, accept anything (not safe). This is the backup source of
 * truth for payment status if the browser-side verify-payment call never
 * arrives, e.g. the customer closed the tab right after paying.
 */
router.post('/razorpay/webhook', async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body; // Buffer, thanks to express.raw()

  if (!verifyWebhookSignature({ rawBody, signatureHeader: signature })) {
    return res.status(400).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Malformed payload' });
  }

  try {
    const payment = event.payload && event.payload.payment && event.payload.payment.entity;

    // Razorpay's own docs are explicit that a webhook can be delivered more
    // than once for the same event, and their payload does not reliably
    // include a single globally-unique delivery id to dedupe on the way
    // Stripe's evt_xxx does, so the dedupe key here is built from fields we
    // know are present: the event type plus the payment id it is about.
    //
    // The dedupe claim and the actual business update happen inside ONE
    // transaction. That matters: an earlier version of this handler did
    // them as two separate queries, which meant that if the business
    // update ever threw after the dedupe row was already committed, a
    // legitimate Razorpay retry would see "already processed" and skip it
    // forever, silently losing the payment confirmation. Wrapping both in
    // a transaction means a failed update rolls the dedupe claim back too,
    // so the next retry is treated as new and actually gets processed.
    const webhookEventId = req.headers['x-razorpay-event-id'];
    const dedupeKey = webhookEventId || (event.event + ':' + (payment ? payment.id : 'no-payment'));
    const result = await db.withTransaction(async (client) => {
      const claimed = await client.query(
        `INSERT INTO processed_webhook_events (event_id, event_type) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id`,
        [dedupeKey, event.event]
      );
      if (!claimed.rows.length) {
        return { duplicate: true };
      }

      let confirmedOrder = null;
      if (payment && (event.event === 'payment.captured' || event.event === 'order.paid')) {
        const updated = await client.query(
          `UPDATE orders SET status = 'PROCESSING', razorpay_payment_id = $1, paid_at = COALESCE(paid_at, now()), updated_at = now()
           WHERE razorpay_order_id = $2 AND status = 'PENDING_PAYMENT'
           RETURNING id, display_id AS "displayId", customer_name AS "customerName", customer_email AS "customerEmail", total`,
          [payment.id, payment.order_id]
        );
        if (updated.rows.length) {
          await finalizeReservation(client, updated.rows[0].id);
          confirmedOrder = updated.rows[0];
        } else {
          await client.query(`UPDATE orders SET razorpay_payment_id = $1, paid_at = COALESCE(paid_at, now()), updated_at = now() WHERE razorpay_order_id = $2 AND status = 'PROCESSING'`, [payment.id, payment.order_id]);
        }
      } else if (payment && event.event === 'payment.failed') {
        const failed = await client.query(
          `SELECT id FROM orders WHERE razorpay_order_id = $1 AND status = 'PENDING_PAYMENT' FOR UPDATE`,
          [payment.order_id]
        );
        if (failed.rows.length) {
          await releaseReservation(client, failed.rows[0].id);
          await client.query(`UPDATE orders SET payment_failure_reason = $1, updated_at = now() WHERE id = $2`, [payment.error_description || payment.error_reason || 'Payment failed', failed.rows[0].id]);
        }
      }
      // All handled events remain under the same database transaction as
      // their business-state changes, so a failure is retryable.
      return { duplicate: false, confirmedOrder };
    });

    if (result.confirmedOrder) {
      const itemsResult = await db.query('SELECT name, size, color, qty FROM order_items WHERE order_id = $1', [result.confirmedOrder.id]);
      notifyOrderConfirmed({ ...result.confirmedOrder, items: itemsResult.rows }).catch(() => {});
    }

    res.json({ received: true, duplicate: result.duplicate });
  } catch (err) {
    console.error('Webhook processing error', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

module.exports = router;
