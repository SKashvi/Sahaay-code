-- Customer-initiated order cancellation.
--
-- The order side needs nothing new. 'CANCELLED' is already one of the
-- statuses in 001_initial.sql, and cancelled_at already exists from
-- 004_item_returns_and_order_lifecycle.sql, so no status or column is
-- invented here.
--
-- What is genuinely missing is a way to tell the two kinds of refund apart.
-- Cancelling a PAID order owes the customer money, and that money must go
-- through the same human approval gate a return refund goes through: a row
-- that an admin approves, and only then can be refunded via Razorpay (see
-- src/lib/refunds.js, which will not touch a row that is not APPROVED).
-- Reusing return_requests gets that gate, the REFUND_PENDING locking, and
-- the refund idempotency key for free. Without a kind column, though, a
-- cancellation refund would show in the dashboard as a return of goods the
-- customer never received and never sent back.

ALTER TABLE return_requests
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'RETURN';

ALTER TABLE return_requests
  DROP CONSTRAINT IF EXISTS return_requests_kind_check;
ALTER TABLE return_requests
  ADD CONSTRAINT return_requests_kind_check CHECK (kind IN ('RETURN', 'CANCELLATION'));

-- Every row that existed before this migration is a return of goods, which
-- is what the default already gives them. Stated explicitly so the intent
-- survives a reader who does not trust the default.
UPDATE return_requests SET kind = 'RETURN' WHERE kind IS NULL;

-- The dashboard lists the two side by side and filters between them.
CREATE INDEX IF NOT EXISTS idx_return_requests_kind ON return_requests (kind, created_at DESC);

-- One live cancellation refund per order. A customer who cancels twice, or a
-- retried request, must not create a second claim on the same money. Returns
-- are deliberately left alone: an order can legitimately have several.
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_requests_one_cancellation
  ON return_requests (order_id)
  WHERE kind = 'CANCELLATION' AND status <> 'REJECTED';
