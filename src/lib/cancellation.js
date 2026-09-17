/* Customer-initiated order cancellation.
 *
 * One function, three callers: the tracking page (POST /api/orders/cancel),
 * the agent's cancel_order tool, and the admin dashboard's own approval of an
 * agent CANCELLATION proposal. They differ only in how they prove who is
 * asking; what cancelling means is decided here, once.
 *
 * Two hard rules:
 *
 *   1. The order state machine decides whether the transition is legal.
 *      Nothing here writes orders.status directly, so cancelling cannot take
 *      a shortcut past it, and releasing or restoring inventory happens as
 *      part of that same transition.
 *   2. Cancelling never moves money. When the order was actually paid, this
 *      records a refund request that an admin must approve before Razorpay is
 *      called at all (src/lib/refunds.js refuses any row that is not
 *      APPROVED). The customer is told it is with the team, never that a
 *      refund is on its way.
 */

const db = require('./db');
const { newId, newDisplayId } = require('./ids');
const { transitionOrder } = require('./orderStateMachine');

/* Mirrors ReturnEligibilityError in ./returns.js: a 400 carrying a sentence
 * that is safe to show a customer verbatim. */
class CancellationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CancellationError';
    this.status = 400;
  }
}

/* The only two states a customer can cancel from, taken from the statuses
 * that already exist in 001_initial.sql. Everything past PROCESSING has
 * physically left the building. */
const CANCELLABLE_STATUSES = ['PENDING_PAYMENT', 'PROCESSING'];

/* Refusals mirror how src/lib/returns.js refuses a return before delivery:
 * name the state, then point at the route that does apply. */
function checkCancellable(order) {
  if (!order) throw new CancellationError('We could not find that order.');
  if (order.status === 'CANCELLED') {
    throw new CancellationError('This order has already been cancelled.');
  }
  if (order.status === 'DELIVERED') {
    throw new CancellationError('This order has already been delivered, so it cannot be cancelled. You can request a return instead.');
  }
  if (order.status === 'SHIPPED' || order.status === 'OUT_FOR_DELIVERY') {
    throw new CancellationError('This order has already shipped, so it cannot be cancelled. Once it arrives you can request a return.');
  }
  if (!CANCELLABLE_STATUSES.includes(order.status)) {
    throw new CancellationError('This order cannot be cancelled at its current stage.');
  }
}

/** Read-only, for deciding whether to offer a Cancel control at all. */
function isCancellable(order) {
  return Boolean(order) && CANCELLABLE_STATUSES.includes(order.status);
}

/**
 * Cancels an order the caller has already established the customer owns.
 *
 * @param {string} orderId  internal id, never a display id from a request
 * @returns {{ order, refund: null | { displayId, amount, status } }}
 *   refund is non-null only when the order was paid, and describes a request
 *   awaiting human approval, not a refund that has happened.
 */
async function cancelOrder(orderId) {
  const existing = await db.query(
    `SELECT id, display_id AS "displayId", status, total, razorpay_payment_id AS "razorpayPaymentId"
       FROM orders WHERE id = $1`,
    [orderId]
  );
  const order = existing.rows[0];
  // Checked before the transition so the customer gets the sentence above
  // rather than the state machine's internal "Cannot move an order from
  // SHIPPED to CANCELLED", which reads like a bug report.
  checkCancellable(order);

  // Does the inventory work and stamps cancelled_at, and refuses the
  // transition outright if the status moved under us between the read above
  // and now.
  const cancelled = await transitionOrder(orderId, 'CANCELLED');

  // An unpaid order owes nothing: the reservation is released and that is the
  // whole story.
  if (!order.razorpayPaymentId) {
    return { order: cancelled, refund: null };
  }

  const refund = await db.withTransaction(async (client) => {
    // The partial unique index from migration 014 enforces this too. Checked
    // here as well so a second cancel attempt reports the existing request
    // instead of surfacing a constraint violation.
    const open = await client.query(
      `SELECT display_id AS "displayId", refund_amount AS "refundAmount", status
         FROM return_requests
        WHERE order_id = $1 AND kind = 'CANCELLATION' AND status <> 'REJECTED'
        FOR UPDATE`,
      [orderId]
    );
    if (open.rows.length) {
      return { displayId: open.rows[0].displayId, amount: open.rows[0].refundAmount, status: open.rows[0].status, existing: true };
    }

    // The full amount charged, shipping included, because nothing was
    // delivered. Read from the order, never from the caller. SUBMITTED, not
    // APPROVED: an admin has to approve it before any refund can run.
    const refundId = newId();
    const refundDisplayId = newDisplayId('RET');
    await client.query(
      `INSERT INTO return_requests (id, display_id, order_id, kind, reason, description, refund_amount, status)
       VALUES ($1, $2, $3, 'CANCELLATION', $4, $5, $6, 'SUBMITTED')`,
      [
        refundId,
        refundDisplayId,
        orderId,
        'Order cancelled',
        'Customer cancelled this order before it shipped. Refund of the full amount paid, pending review.',
        order.total,
      ]
    );
    return { displayId: refundDisplayId, amount: order.total, status: 'SUBMITTED', existing: false };
  });

  return { order: cancelled, refund };
}

module.exports = { cancelOrder, checkCancellable, isCancellable, CancellationError, CANCELLABLE_STATUSES };
