const RETURN_WINDOW_DAYS = Number(process.env.RETURN_WINDOW_DAYS) || 14;

class ReturnEligibilityError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

/**
 * Can a return even be started against this order at all. Checked before
 * looking at which specific items are being requested.
 */
function checkOrderEligibility(order) {
  if (order.status === 'PENDING_PAYMENT') {
    throw new ReturnEligibilityError('This order has not been paid yet, there is nothing to return.');
  }
  if (order.status === 'CANCELLED') {
    throw new ReturnEligibilityError('This order was cancelled, there is nothing to return.');
  }
  if (order.status !== 'DELIVERED') {
    throw new ReturnEligibilityError('Returns can be started once an order has been delivered.');
  }
  if (order.delivered_at) {
    const deadlineMs = new Date(order.delivered_at).getTime() + RETURN_WINDOW_DAYS * 86400000;
    if (Date.now() > deadlineMs) {
      throw new ReturnEligibilityError(`The ${RETURN_WINDOW_DAYS} day return window for this order has passed.`);
    }
  }
}

/**
 * Validates the requested items/quantities against what was actually
 * ordered and what has already been claimed by any non-rejected return
 * (submitted, approved, refund pending, or refunded), and computes the
 * refund amount for each line from the order_item's real recorded price.
 * Never trusts a refund amount from the client, there is not even a field
 * for one in the request schema.
 *
 * Must be called with a client that already has the relevant order_items
 * rows locked (SELECT ... FOR UPDATE), see routes/returns.js, so two
 * concurrent return submissions for the same item cannot both read
 * "plenty left" and both succeed in over-returning it.
 */
async function resolveReturnItems(client, orderId, requestedItems) {
  const orderItemIds = requestedItems.map((i) => i.orderItemId);

  // What the customer actually paid per rupee of sticker price. Orders placed
  // without an offer have a ratio of 1 and are unaffected. An order placed
  // with 20% off refunds 80% of the line price, because that is what was
  // charged. The ratio is read from the ORDER, not from the offers table, so
  // editing or deleting an offer later cannot change what an old order
  // refunds.
  const orderRow = await client.query('SELECT refund_ratio FROM orders WHERE id = $1', [orderId]);
  const refundRatio = orderRow.rows.length ? Number(orderRow.rows[0].refund_ratio) : 1;
  const ratio = Number.isFinite(refundRatio) && refundRatio > 0 && refundRatio <= 1 ? refundRatio : 1;
  const rows = await client.query(
    `SELECT id, order_id, name, price, qty FROM order_items WHERE id = ANY($1::uuid[]) FOR UPDATE`,
    [orderItemIds]
  );
  const byId = new Map(rows.rows.map((r) => [r.id, r]));

  const alreadyReturned = await client.query(
    `SELECT ri.order_item_id, COALESCE(SUM(ri.quantity), 0)::int AS qty
     FROM return_items ri
     JOIN return_requests rr ON rr.id = ri.return_id
     WHERE ri.order_item_id = ANY($1::uuid[]) AND rr.status != 'REJECTED'
     GROUP BY ri.order_item_id`,
    [orderItemIds]
  );
  const returnedById = new Map(alreadyReturned.rows.map((r) => [r.order_item_id, r.qty]));

  const resolved = [];
  let totalRefund = 0;
  for (const requested of requestedItems) {
    const item = byId.get(requested.orderItemId);
    if (!item || item.order_id !== orderId) {
      throw new ReturnEligibilityError('One of the selected items does not belong to this order.');
    }
    const alreadyReturnedQty = returnedById.get(requested.orderItemId) || 0;
    const remaining = item.qty - alreadyReturnedQty;
    if (requested.quantity > remaining) {
      throw new ReturnEligibilityError(
        remaining <= 0
          ? `"${item.name}" has already been fully claimed by a return.`
          : `Only ${remaining} of "${item.name}" can still be returned.`
      );
    }
    // Rounded down, so the sum of line refunds can never exceed what was
    // charged for the order.
    const refundAmount = Math.floor(item.price * requested.quantity * ratio);
    resolved.push({ orderItemId: item.id, name: item.name, quantity: requested.quantity, refundAmount });
    totalRefund += refundAmount;
  }
  return { resolved, totalRefund };
}

module.exports = { checkOrderEligibility, resolveReturnItems, ReturnEligibilityError, RETURN_WINDOW_DAYS };
