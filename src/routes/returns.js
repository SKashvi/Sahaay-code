const express = require('express');
const db = require('../lib/db');
const { newId, newDisplayId } = require('../lib/ids');
const { validateBody } = require('../middleware/validate');
const { returnRequestSchema } = require('../schemas');
const { trackOrderLimiter } = require('../middleware/rateLimiters');
const { isOwnUploadUrl } = require('../lib/storage');
const { scoreInBackground } = require('../lib/agent/photoScoring');
const { checkOrderEligibility, resolveReturnItems, ReturnEligibilityError } = require('../lib/returns');
const { notifyReturnSubmitted } = require('../lib/notifications');

const router = express.Router();

router.post('/', trackOrderLimiter, validateBody(returnRequestSchema), async (req, res, next) => {
  try {
    const { displayId, email, items, reason, description, photoUrl } = req.body;

    if (photoUrl && !isOwnUploadUrl(photoUrl)) {
      return res.status(400).json({ error: 'Photo could not be attached, please upload it again.' });
    }

    const result = await db.withTransaction(async (client) => {
      const orderResult = await client.query(
        `SELECT id, status, delivered_at FROM orders WHERE display_id = $1 AND lower(customer_email) = lower($2)`,
        [displayId, email]
      );
      if (!orderResult.rows.length) {
        throw new ReturnEligibilityError('We could not match that order and email.');
      }
      const order = orderResult.rows[0];

      checkOrderEligibility(order);
      const { resolved, totalRefund } = await resolveReturnItems(client, order.id, items);

      const returnId = newId();
      const returnDisplayId = newDisplayId('RET');
      await client.query(
        `INSERT INTO return_requests (id, display_id, order_id, reason, description, photo_url, refund_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [returnId, returnDisplayId, order.id, reason, description || null, photoUrl || null, totalRefund]
      );
      for (const item of resolved) {
        await client.query(
          `INSERT INTO return_items (id, return_id, order_item_id, quantity, refund_amount) VALUES ($1,$2,$3,$4,$5)`,
          [newId(), returnId, item.orderItemId, item.quantity, item.refundAmount]
        );
      }
      return { returnId, returnDisplayId, totalRefund, items: resolved };
    });

    res.status(201).json({ displayId: result.returnDisplayId, refundAmount: result.totalRefund, items: result.items });
    notifyReturnSubmitted(email, result.returnDisplayId, displayId).catch(() => {});
    // Advice for whoever reviews this, written onto the row in the
    // background. The customer's submission never waits on it.
    scoreInBackground({ table: 'return_requests', id: result.returnId, photoUrl, reason, description });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
