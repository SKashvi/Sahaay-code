const db = require('./db');
const { releaseReservation } = require('./inventoryReservations');

/**
 * Every arrow here is a transition an admin (or a future automated
 * process) is allowed to make. Anything not listed is rejected. This is
 * the one place that decides that, nothing else in the app should update
 * orders.status directly.
 */
const ALLOWED_TRANSITIONS = {
  PENDING_PAYMENT: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['SHIPPED', 'CANCELLED'],
  SHIPPED: ['OUT_FOR_DELIVERY', 'DELIVERED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [], // terminal, a delivered order is not un-delivered by changing a dropdown
  CANCELLED: [], // terminal
};

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Cannot move an order from ${from} to ${to}.`);
    this.status = 400;
  }
}

/**
 * Applies a validated transition and stamps the matching lifecycle
 * timestamp (shipped_at / delivered_at / cancelled_at) in the same
 * statement, so those timestamps can never drift out of sync with the
 * status they describe. Returns the new row, or throws if the order does
 * not exist or the transition is not allowed from its current status.
 */
async function transitionOrder(orderId, toStatus, extra) {
  extra = extra || {};
  return db.withTransaction(async (client) => {
    const current = await client.query('SELECT status FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!current.rows.length) {
      const err = new Error('Order not found');
      err.status = 404;
      throw err;
    }
    const fromStatus = current.rows[0].status;
    if (fromStatus === toStatus) {
      // Setting a status to what it already is is a no-op, not an error,
      // an admin re-saving a form should not blow up.
      const same = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);
      return same.rows[0];
    }
    const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new InvalidTransitionError(fromStatus, toStatus);
    }

    const timestampColumn = { SHIPPED: 'shipped_at', DELIVERED: 'delivered_at', CANCELLED: 'cancelled_at' }[toStatus];

    const setParts = ['status = $1', 'updated_at = now()'];
    const params = [toStatus];
    if (timestampColumn) {
      setParts.push(`${timestampColumn} = now()`);
    }
    if (extra.trackingCarrier !== undefined) { params.push(extra.trackingCarrier); setParts.push(`tracking_carrier = $${params.length}`); }
    if (extra.trackingNumber !== undefined) { params.push(extra.trackingNumber); setParts.push(`tracking_number = $${params.length}`); }
    if (extra.trackingUrl !== undefined) { params.push(extra.trackingUrl); setParts.push(`tracking_url = $${params.length}`); }
    params.push(orderId);

    if (toStatus === 'CANCELLED' && fromStatus === 'PENDING_PAYMENT') {
      await releaseReservation(client, orderId);
    }
    const result = await client.query(
      `UPDATE orders SET ${setParts.join(', ')} WHERE id = $${params.length} RETURNING *`,
      params
    );
    return result.rows[0];
  });
}

module.exports = { transitionOrder, ALLOWED_TRANSITIONS, InvalidTransitionError };
