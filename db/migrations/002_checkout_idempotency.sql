-- Adds idempotency support so a double-submitted checkout (double click,
-- retried request after a dropped connection) creates at most one order,
-- and so a Razorpay webhook delivered more than once (their docs say to
-- expect this) is only ever acted on once.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key ON orders (idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  event_id    TEXT PRIMARY KEY, -- Razorpay's own event id, from the webhook payload
  event_type  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
