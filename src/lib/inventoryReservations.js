const db = require('./db');
const { razorpay } = require('./razorpay');

const DEFAULT_MINUTES = 20;
const RESERVATION_MINUTES = Math.max(5, Number(process.env.INVENTORY_RESERVATION_MINUTES) || DEFAULT_MINUTES);

async function finalizeReservation(client, orderId) {
  const order = await client.query(
    `SELECT id, status, reservation_released_at AS "reservationReleasedAt" FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId]
  );
  if (!order.rows.length || order.rows[0].reservationReleasedAt) return;

  const items = await client.query(`SELECT variant_id AS "variantId", qty FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL`, [orderId]);
  for (const item of items.rows) {
    await client.query(
      `UPDATE product_variants SET reserved_quantity = reserved_quantity - $1, updated_at = now()
       WHERE id = $2 AND reserved_quantity >= $1`,
      [item.qty, item.variantId]
    );
  }
  await client.query(
    `UPDATE orders SET reservation_released_at = now(), reservation_expires_at = NULL, updated_at = now() WHERE id = $1`,
    [orderId]
  );
}

async function releaseReservation(client, orderId) {
  const order = await client.query(
    `SELECT id, status, reservation_released_at AS "reservationReleasedAt" FROM orders WHERE id = $1 FOR UPDATE`,
    [orderId]
  );
  if (!order.rows.length || order.rows[0].reservationReleasedAt) return false;

  const items = await client.query(`SELECT variant_id AS "variantId", qty FROM order_items WHERE order_id = $1 AND variant_id IS NOT NULL`, [orderId]);
  for (const item of items.rows) {
    await client.query(
      `UPDATE product_variants SET stock_quantity = stock_quantity + $1, reserved_quantity = GREATEST(reserved_quantity - $1, 0), updated_at = now()
       WHERE id = $2`,
      [item.qty, item.variantId]
    );
  }
  await client.query(
    `UPDATE orders SET reservation_released_at = now(), reservation_expires_at = NULL, status = 'CANCELLED', cancelled_at = COALESCE(cancelled_at, now()), updated_at = now() WHERE id = $1 AND status = 'PENDING_PAYMENT'`,
    [orderId]
  );
  return true;
}

async function releaseExpiredReservations() {
  const candidates = await db.query(
    `SELECT id, razorpay_order_id AS "razorpayOrderId" FROM orders
     WHERE status = 'PENDING_PAYMENT' AND reservation_released_at IS NULL
       AND reservation_expires_at IS NOT NULL AND reservation_expires_at < now()
     ORDER BY reservation_expires_at ASC LIMIT 50`
  );

  let released = 0;
  for (const row of candidates.rows) {
    let razorOrder;
    try {
      razorOrder = await razorpay.orders.fetch(row.razorpayOrderId);
    } catch (err) {
      console.error(`Could not verify Razorpay order ${row.razorpayOrderId} before releasing reservation:`, err.message);
      continue;
    }

    // Razorpay documents order states such as created/attempted/paid. Only
    // release a reservation when the order is still untouched. An attempted
    // payment is left alone so a late authorized/captured payment cannot race
    // with an automatic stock release. Payment.failed is handled immediately
    // by the webhook below.
    if (razorOrder.status !== 'created') continue;

    const didRelease = await db.withTransaction((client) => releaseReservation(client, row.id));
    if (didRelease) released += 1;
  }
  return released;
}

module.exports = { RESERVATION_MINUTES, finalizeReservation, releaseReservation, releaseExpiredReservations };
