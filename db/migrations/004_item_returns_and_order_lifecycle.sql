-- Adds what item-level returns, return eligibility, order state transitions,
-- and safe concurrent refunds all need underneath them.

-- Order lifecycle timestamps, used both to drive the state machine and to
-- calculate the return eligibility window from delivered_at rather than
-- from placed_at (a return window makes sense counted from delivery, not
-- from when the order was placed).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS shipped_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_carrier TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_number TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tracking_url TEXT;

-- Lets checkout tell "the same request, retried" apart from "this
-- idempotency key got reused for a different cart", which should be
-- rejected rather than silently returning the wrong order.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS request_fingerprint TEXT;

-- REFUND_PENDING is a real, held state: the row is claimed by exactly one
-- refund attempt (via SELECT ... FOR UPDATE, see src/lib/refunds.js) before
-- the slow Razorpay call happens, so a second concurrent attempt sees this
-- state and backs off instead of also calling Razorpay.
ALTER TABLE return_requests DROP CONSTRAINT IF EXISTS return_requests_status_check;
ALTER TABLE return_requests ADD CONSTRAINT return_requests_status_check
  CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','REFUND_PENDING','REFUNDED'));

-- A return now names exactly which order items, and how many of each, are
-- being returned. refund_amount here is computed server side from the
-- order_item's actual paid price at order time, per line, never trusted
-- from the client and never assumed to be the whole order.
CREATE TABLE IF NOT EXISTS return_items (
  id             UUID PRIMARY KEY,
  return_id      UUID NOT NULL REFERENCES return_requests(id) ON DELETE CASCADE,
  order_item_id  UUID NOT NULL REFERENCES order_items(id),
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  refund_amount  INTEGER NOT NULL CHECK (refund_amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_return_items_return_id ON return_items (return_id);
CREATE INDEX IF NOT EXISTS idx_return_items_order_item_id ON return_items (order_item_id);
