const db = require('./db');
const crypto = require('crypto');

class RefundConflictError extends Error {
  constructor(message) { super(message); this.status = 409; }
}
class RefundInvalidStateError extends Error {
  constructor(message) { super(message); this.status = 400; }
}

/**
 * Locks the return_requests row (SELECT ... FOR UPDATE) and, if it is in a
 * refundable state and not already claimed, moves it to REFUND_PENDING
 * before the transaction commits and the lock is released. A second,
 * truly concurrent call for the same return blocks on the row lock until
 * the first one commits, then sees status = REFUND_PENDING and backs off
 * with a conflict instead of also calling Razorpay. This is what a
 * sequential "call it twice and check the second call is a no-op" test
 * cannot prove, only a genuine concurrent race can, see
 * test/refund-concurrency.test.js.
 *
 * Deliberately a short, separate transaction from the actual Razorpay
 * call: a slow external HTTP request should never happen while a database
 * row lock is held.
 */
async function claimReturnForRefund(returnId) {
  return db.withTransaction(async (client) => {
    const result = await client.query(
      `SELECT r.id, r.status, r.razorpay_refund_id AS "razorpayRefundId", r.refund_amount AS "refundAmount", r.refund_idempotency_key AS "refundIdempotencyKey",
              r.display_id AS "displayId", o.razorpay_payment_id AS "razorpayPaymentId", o.customer_email AS "customerEmail"
       FROM return_requests r JOIN orders o ON o.id = r.order_id
       WHERE r.id = $1 FOR UPDATE`,
      [returnId]
    );
    if (!result.rows.length) {
      const err = new Error('Return request not found');
      err.status = 404;
      throw err;
    }
    const ret = result.rows[0];

    if (ret.razorpayRefundId) {
      return { alreadyRefunded: true, razorpayRefundId: ret.razorpayRefundId, refundAmount: ret.refundAmount };
    }
    if (ret.status === 'REFUND_PENDING') {
      throw new RefundConflictError('A refund for this return is already being processed. Wait a moment and check back before retrying.');
    }
    if (ret.status === 'REJECTED') {
      throw new RefundInvalidStateError('This return was rejected. Approve it first if it should be refunded after all.');
    }
    if (ret.status !== 'APPROVED') {
      throw new RefundInvalidStateError('Approve this return before refunding it.');
    }
    if (!ret.razorpayPaymentId) {
      throw new RefundInvalidStateError('The order behind this return was never actually paid, there is nothing to refund.');
    }
    if (!ret.refundAmount || ret.refundAmount <= 0) {
      throw new RefundInvalidStateError('This return has no refundable amount recorded.');
    }

    const refundIdempotencyKey = ret.refundIdempotencyKey || `ret-${returnId}-${crypto.randomUUID()}`;
    await client.query(`UPDATE return_requests SET status = 'REFUND_PENDING', refund_idempotency_key = $1, updated_at = now() WHERE id = $2`, [refundIdempotencyKey, returnId]);
    return {
      claimed: true,
      priorStatus: ret.status,
      razorpayPaymentId: ret.razorpayPaymentId,
      refundAmount: ret.refundAmount,
      refundIdempotencyKey,
      displayId: ret.displayId,
      customerEmail: ret.customerEmail,
    };
  });
}

async function finalizeRefundSuccess(returnId, refund) {
  await db.query(
    `UPDATE return_requests SET status = 'REFUNDED', razorpay_refund_id = $1, refunded_at = now(), refund_error = NULL, updated_at = now()
     WHERE id = $2`,
    [refund.id, returnId]
  );
}

/** Puts the return back into whatever state it was in before the failed
 * attempt claimed it, rather than leaving it stuck in REFUND_PENDING
 * forever, and records the error so an admin can see why and retry. */
async function finalizeRefundFailure(returnId, priorStatus, errorMessage) {
  await db.query(
    `UPDATE return_requests SET status = $1, refund_error = $2, updated_at = now() WHERE id = $3`,
    [priorStatus, errorMessage, returnId]
  );
}

module.exports = { claimReturnForRefund, finalizeRefundSuccess, finalizeRefundFailure, RefundConflictError, RefundInvalidStateError };
