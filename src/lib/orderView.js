/* The one shape an order is described in.
 *
 * Three callers need "what is the state of this order": the agent's
 * get_order_status tool, the widget's orders panel, and anything else that
 * comes later. They must not each assemble their own version, because the
 * panel's Cancel button appearing when the agent thinks cancelling is
 * impossible (or the reverse) is a bug the customer sees and neither side
 * owns.
 *
 * Reading an order is a database call and nothing more. The panel path never
 * goes near the model, so a rate limit or a provider outage cannot stop a
 * verified customer seeing their order.
 */

const db = require('./db');
const { paiseToRupeeString } = require('./ids');
const { RETURN_WINDOW_DAYS } = require('./returns');
const { isCancellable } = require('./cancellation');

/* The steps the storefront's tracking page already draws, in order, so the
 * widget's panel and that page cannot disagree about what "shipped" looks
 * like. CANCELLED is deliberately absent: it is not a stage along this path,
 * it is a departure from it, and the panel says so separately. */
const ORDER_STAGES = ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const ORDER_STAGE_LABELS = {
  PENDING_PAYMENT: 'Payment pending',
  PROCESSING: 'Processing',
  SHIPPED: 'Shipped',
  OUT_FOR_DELIVERY: 'Out for delivery',
  DELIVERED: 'Delivered',
};

/**
 * @param {string} orderId  internal id, from a verified session, never from a
 *                          request body
 * @returns {object|null}   null when the order does not exist
 */
async function buildOrderView(orderId) {
  const orderResult = await db.query(
    `SELECT display_id AS "displayId", status, total, created_at AS "createdAt",
            shipped_at AS "shippedAt", delivered_at AS "deliveredAt", cancelled_at AS "cancelledAt",
            tracking_carrier AS "trackingCarrier", tracking_number AS "trackingNumber", tracking_url AS "trackingUrl"
       FROM orders WHERE id = $1`,
    [orderId]
  );
  if (!orderResult.rows.length) return null;

  const order = orderResult.rows[0];
  const itemsResult = await db.query(
    `SELECT id AS "itemId", name, size, color, qty, price FROM order_items WHERE order_id = $1`,
    [orderId]
  );

  const items = itemsResult.rows.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    size: row.size,
    color: row.color,
    qty: row.qty,
    price: paiseToRupeeString(row.price),
  }));

  const returnable = order.status === 'DELIVERED' && order.deliveredAt
    && (Date.now() - new Date(order.deliveredAt).getTime()) < RETURN_WINDOW_DAYS * 86400000;

  return {
    displayId: order.displayId,
    status: order.status,
    statusLabel: ORDER_STAGE_LABELS[order.status] || (order.status === 'CANCELLED' ? 'Cancelled' : order.status),
    stages: ORDER_STAGES,
    stageLabels: ORDER_STAGE_LABELS,
    // -1 for a cancelled order, which is not anywhere along the track.
    stageIndex: ORDER_STAGES.indexOf(order.status),
    total: paiseToRupeeString(order.total),
    placedAt: order.createdAt,
    tracking: order.trackingNumber
      ? { carrier: order.trackingCarrier, number: order.trackingNumber, url: order.trackingUrl }
      : null,
    items,
    // What the panel draws its buttons from. The server decides; the client
    // only decides whether to render a control, and every endpoint behind one
    // re-checks regardless of what the client thought.
    canCancel: isCancellable(order),
    canRequestReturn: Boolean(returnable),
    canRequestCancellation: isCancellable(order),
    returnWindowDays: RETURN_WINDOW_DAYS,
  };
}

/* Every order for an email, newest first, as summary rows.
 *
 * Deliberately not the full view: a list of ten orders does not need ten sets
 * of line items, and the detail view fetches the one the customer opens. Item
 * count and total are what a row shows.
 *
 * The email comes from the verified session, never from a request body, so
 * this cannot be pointed at somebody else's address.
 */
async function listOrdersForEmail(email, { search } = {}) {
  const filter = String(search || '').trim();
  const result = await db.query(
    `SELECT o.display_id AS "displayId", o.status, o.total, o.created_at AS "createdAt",
            COALESCE(SUM(i.qty), 0)::int AS "itemCount"
       FROM orders o
       LEFT JOIN order_items i ON i.order_id = o.id
      WHERE lower(o.customer_email) = lower($1)
        AND ($2 = '' OR o.display_id ILIKE '%' || $2 || '%')
      GROUP BY o.id
      ORDER BY o.created_at DESC
      LIMIT 50`,
    [String(email || '').trim(), filter]
  );
  return result.rows.map((row) => ({
    displayId: row.displayId,
    status: row.status,
    statusLabel: ORDER_STAGE_LABELS[row.status] || (row.status === 'CANCELLED' ? 'Cancelled' : row.status),
    total: paiseToRupeeString(row.total),
    itemCount: row.itemCount,
    placedAt: row.createdAt,
  }));
}

/* One order by display id, scoped to the verified email. The scoping is the
 * authorisation: a display id from somewhere else resolves to nothing rather
 * than to somebody else's order. */
async function buildOrderViewForEmail(email, displayId) {
  const found = await db.query(
    'SELECT id FROM orders WHERE display_id = $1 AND lower(customer_email) = lower($2)',
    [String(displayId || '').trim(), String(email || '').trim()]
  );
  if (!found.rows.length) return null;
  return buildOrderView(found.rows[0].id);
}

module.exports = {
  buildOrderView,
  buildOrderViewForEmail,
  listOrdersForEmail,
  ORDER_STAGES,
  ORDER_STAGE_LABELS,
};
