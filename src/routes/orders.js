const express = require('express');
const crypto = require('crypto');
const db = require('../lib/db');
const { newId, newDisplayId } = require('../lib/ids');
const { createRazorpayOrder, verifyPaymentSignature } = require('../lib/razorpay');
const { validateBody } = require('../middleware/validate');
const { checkoutSchema, verifyPaymentSchema, trackOrderSchema } = require('../schemas');
const { trackOrderLimiter, checkoutLimiter } = require('../middleware/rateLimiters');
const { notifyOrderConfirmed } = require('../lib/notifications');
const { RESERVATION_MINUTES, finalizeReservation, releaseReservation } = require('../lib/inventoryReservations');
const { findUsableOffer, applyOffer, computeRefundRatio } = require('../lib/offers');

const router = express.Router();

// Configurable so the frontend and backend can read the exact same numbers
// (via GET /api/config) instead of two hardcoded copies quietly drifting
// apart, which is how a checkout page ends up showing a different total
// than what Razorpay actually charges.
const SHIPPING_FREE_THRESHOLD = Number(process.env.SHIPPING_FREE_THRESHOLD) || 199900; // paise, i.e. Rs 1,999
const SHIPPING_FLAT_FEE = Number(process.env.SHIPPING_FLAT_FEE) || 9900; // paise, i.e. Rs 99

/** Identifies "the same purchase attempt", not just "the same key", so an
 * idempotency key that gets reused for a materially different cart or
 * customer is rejected with a conflict instead of silently handing back
 * whatever order the key was first used for. */
function computeRequestFingerprint(items, customer, offerCode) {
  const normalizedItems = items
    .map((i) => `${i.productId}:${i.size}:${i.color}:${i.qty}`)
    .sort()
    .join('|');
  // The offer code is part of what makes a checkout "the same attempt". A
  // retry that adds or changes a code is a different price, so it must not
  // silently replay the order created at the old price.
  return crypto.createHash('sha256')
    .update(normalizedItems + '::' + customer.email.toLowerCase() + '::' + String(offerCode || '').toUpperCase())
    .digest('hex');
}

/**
 * Creates an order in PENDING_PAYMENT status. Every price used here comes
 * from the products table, never from the request body. A client could
 * send price: 1 for every item and it would be ignored entirely, the
 * amount charged is always recomputed server side from what is actually in
 * the database right now.
 */
router.post('/checkout', checkoutLimiter, validateBody(checkoutSchema), async (req, res, next) => {
  try {
    const { idempotencyKey, items, customer, offerCode } = req.body;
    const fingerprint = computeRequestFingerprint(items, customer, offerCode);

    // If this exact checkout attempt already went through (double click,
    // a retried request after the response was lost, etc), return the
    // order that was already created for it instead of making another one.
    // If the SAME key shows up with a DIFFERENT cart or customer, that is
    // not a retry, it is key reuse, and silently returning the old order
    // would be wrong, so it is rejected with a conflict instead.
    const existing = await db.query(
      `SELECT id AS "orderId", display_id AS "displayId", total, subtotal, discount, offer_code AS "offerCode", shipping, razorpay_order_id AS "razorpayOrderId", request_fingerprint AS "requestFingerprint"
       FROM orders WHERE idempotency_key = $1`,
      [idempotencyKey]
    );
    if (existing.rows.length) {
      if (existing.rows[0].requestFingerprint !== fingerprint) {
        return res.status(409).json({ error: 'This checkout session is stale, please refresh the page and try again.' });
      }
      const { requestFingerprint, ...publicOrder } = existing.rows[0];
      return res.status(200).json({ ...publicOrder, razorpayKeyId: process.env.RAZORPAY_KEY_ID, replay: true });
    }

    const productIds = items.map((i) => i.productId);

    const productRows = await db.query(
      'SELECT id, name, price, sizes, colors, active FROM products WHERE id = ANY($1::uuid[])',
      [productIds]
    );
    const productsById = new Map(productRows.rows.map((p) => [p.id, p]));

    const variantRows = await db.query(
      `SELECT id, product_id, size, color, active FROM product_variants WHERE product_id = ANY($1::uuid[])`,
      [productIds]
    );
    const variantByKey = new Map(variantRows.rows.map((v) => [`${v.product_id}::${v.size}::${v.color}`, v]));

    const resolvedItems = [];
    for (const line of items) {
      const product = productsById.get(line.productId);
      if (!product || !product.active) {
        return res.status(400).json({ error: 'One of the items in your cart is no longer available.' });
      }
      if (!product.sizes.includes(line.size)) {
        return res.status(400).json({ error: `${product.name} is not available in size ${line.size}.` });
      }
      if (!product.colors.some((c) => c.name === line.color)) {
        return res.status(400).json({ error: `${product.name} is not available in color ${line.color}.` });
      }
      const variant = variantByKey.get(`${line.productId}::${line.size}::${line.color}`);
      if (!variant || !variant.active) {
        return res.status(400).json({ error: `${product.name} in ${line.size} / ${line.color} is not available right now.` });
      }
      resolvedItems.push({
        productId: product.id,
        variantId: variant.id,
        name: product.name,
        price: product.price,
        size: line.size,
        color: line.color,
        qty: line.qty,
      });
    }

    const subtotal = resolvedItems.reduce((sum, i) => sum + i.price * i.qty, 0);
    if (subtotal <= 0) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }
    const baseShipping = subtotal >= SHIPPING_FREE_THRESHOLD ? 0 : SHIPPING_FLAT_FEE;

    // The request carries a CODE and nothing else. The discount is looked up
    // and computed here from the offers table, so a browser that posts its
    // own discount amount changes nothing. An unusable code throws rather
    // than being ignored, otherwise a customer who typed one would be
    // charged full price without being told why.
    const offer = await findUsableOffer(null, offerCode);
    const priced = applyOffer(
      offer,
      subtotal,
      resolvedItems.map((i) => ({ productId: i.productId, lineTotal: i.price * i.qty })),
      baseShipping
    );
    const discount = priced.discount;
    const shipping = priced.shipping;
    const total = subtotal - discount + shipping;
    const refundRatio = computeRefundRatio(subtotal, discount);

    const orderId = newId();
    let displayId = newDisplayId('VEL');
    let razorpayOrder;

    for (let attempt = 1; attempt <= 3; attempt++) {
      razorpayOrder = await createRazorpayOrder({ amountPaise: total, receipt: displayId });
      try {
        await db.withTransaction(async (client) => {
          // Stock is decremented with a single conditional UPDATE per line,
          // the WHERE clause's stock check and the decrement happen as one
          // atomic operation under Postgres's row lock, there is no separate
          // read-then-write gap for two concurrent checkouts to both slip
          // through on the last unit. If this returns zero rows, someone
          // else's checkout (possibly happening in this exact instant) has
          // already taken the remaining stock, and the whole transaction
          // rolls back, including the order row and any earlier decrements
          // in this same loop.
          for (const item of resolvedItems) {
            const decremented = await client.query(
              `UPDATE product_variants SET stock_quantity = stock_quantity - $1, reserved_quantity = reserved_quantity + $1, updated_at = now()
               WHERE id = $2 AND active = true AND stock_quantity >= $1
               RETURNING id`,
              [item.qty, item.variantId]
            );
            if (!decremented.rows.length) {
              const err = new Error(`${item.name} in ${item.size} / ${item.color} just sold out.`);
              err.status = 409;
              throw err;
            }
          }

          await client.query(
            `INSERT INTO orders (id, display_id, customer_name, customer_email, customer_phone, address_line, city, state, pincode, subtotal, discount, offer_code, refund_ratio, shipping, total, status, razorpay_order_id, idempotency_key, request_fingerprint, reservation_expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING_PAYMENT',$16,$17,$18, now() + ($19 * interval '1 minute'))`,
            [orderId, displayId, customer.name, customer.email.toLowerCase(), customer.phone, customer.address, customer.city, customer.state, customer.pincode, subtotal, discount, priced.offerCode, refundRatio, shipping, total, razorpayOrder.id, idempotencyKey, fingerprint, RESERVATION_MINUTES]
          );
          for (const item of resolvedItems) {
            await client.query(
              `INSERT INTO order_items (id, order_id, product_id, variant_id, name, price, size, color, qty)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
              [newId(), orderId, item.productId, item.variantId, item.name, item.price, item.size, item.color, item.qty]
            );
          }
        });
        break;
      } catch (err) {
        // A display-id collision is exceptionally unlikely, but the unique constraint
        // must remain the final authority. Retry with a new id instead of surfacing a 500.
        if (err.code === '23505' && err.constraint === 'orders_display_id_key' && attempt < 3) {
          displayId = newDisplayId('VEL');
          continue;
        }
        // A second, near-simultaneous request with the same idempotency key can
        // lose this exact race. Return the winner instead of creating a duplicate.
        if (err.code === '23505' && err.constraint === 'idx_orders_idempotency_key') {
          const winner = await db.query(
            `SELECT id AS "orderId", display_id AS "displayId", total, subtotal, shipping, razorpay_order_id AS "razorpayOrderId", request_fingerprint AS "requestFingerprint"
             FROM orders WHERE idempotency_key = $1`,
            [idempotencyKey]
          );
          if (winner.rows.length) {
            if (winner.rows[0].requestFingerprint !== fingerprint) {
              return res.status(409).json({ error: 'This checkout session is stale, please refresh the page and try again.' });
            }
            const { requestFingerprint, ...publicOrder } = winner.rows[0];
            return res.status(200).json({ ...publicOrder, razorpayKeyId: process.env.RAZORPAY_KEY_ID, replay: true });
          }
        }
        throw err;
      }
    }

    res.status(201).json({
      orderId,
      displayId,
      subtotal,
      discount,
      offerCode: priced.offerCode,
      offerTitle: priced.title,
      shipping,
      total,
      razorpayOrderId: razorpayOrder.id,
      razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Confirms payment for an order. The signature check is the only thing
 * that turns a PENDING_PAYMENT order into PROCESSING, a client cannot mark
 * its own order paid by simply calling this with made up values, the HMAC
 * will not match.
 */
router.post('/verify-payment', validateBody(verifyPaymentSchema), async (req, res, next) => {
  try {
    const { orderId, razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
    const valid = verifyPaymentSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature });
    if (!valid) return res.status(400).json({ error: 'Payment could not be verified.' });

    const result = await db.withTransaction(async (client) => {
      const orderResult = await client.query(
        `SELECT * FROM orders WHERE id = $1 AND razorpay_order_id = $2 FOR UPDATE`,
        [orderId, razorpayOrderId]
      );
      if (!orderResult.rows.length) {
        const err = new Error('Order not found.'); err.status = 404; throw err;
      }
      const order = orderResult.rows[0];
      if (order.status === 'PROCESSING' && order.razorpay_payment_id === razorpayPaymentId) {
        await finalizeReservation(client, orderId);
        return { order, alreadyProcessed: true };
      }
      if (order.status !== 'PENDING_PAYMENT') {
        const err = new Error('Order is no longer awaiting payment.'); err.status = 409; throw err;
      }
      await client.query(
        `UPDATE orders SET status = 'PROCESSING', razorpay_payment_id = $1, paid_at = COALESCE(paid_at, now()), updated_at = now()\n         WHERE id = $2`,
        [razorpayPaymentId, orderId]
      );
      await finalizeReservation(client, orderId);
      const updated = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return { order: updated.rows[0], alreadyProcessed: false };
    });

    const order = result.order;
    const itemsResult = await db.query('SELECT name, size, color, qty FROM order_items WHERE order_id = $1', [orderId]);
    if (!result.alreadyProcessed) {
      notifyOrderConfirmed({
        displayId: order.display_id,
        customerName: order.customer_name,
        customerEmail: order.customer_email,
        total: order.total,
        items: itemsResult.rows,
      }).catch(() => {});
    }
    res.json({ ok: true, displayId: order.display_id, alreadyProcessed: result.alreadyProcessed });
  } catch (err) {
    next(err);
  }
});

/**
 * Order tracking by email + display id. Rate limited since this is a
 * guessable-pair lookup, and always returns the same generic "not found"
 * response whether the email or the order id was the wrong one, so it
 * cannot be used to test which emails have placed orders.
 */
router.post('/track', trackOrderLimiter, validateBody(trackOrderSchema), async (req, res, next) => {
  try {
    const { email, displayId } = req.body;
    const orderResult = await db.query(
      `SELECT id, display_id AS "displayId", status, total, created_at AS "createdAt"
       FROM orders WHERE lower(customer_email) = lower($1) AND display_id = $2`,
      [email, displayId]
    );
    if (!orderResult.rows.length) {
      return res.status(404).json({ error: 'No matching order found. Double check the email and order ID.' });
    }
    const order = orderResult.rows[0];
    const itemsResult = await db.query(
      `SELECT id, name, price, size, color, qty FROM order_items WHERE order_id = $1`,
      [order.id]
    );
    const { id, ...publicOrder } = order; // never expose the internal primary key to the client
    res.json({ order: { ...publicOrder, items: itemsResult.rows } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
