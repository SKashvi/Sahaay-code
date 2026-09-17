-- Inventory reservations keep stock unavailable only while a payment attempt is active.
-- stock_quantity = currently available stock; reserved_quantity = held for pending orders.
ALTER TABLE product_variants ADD COLUMN IF NOT EXISTS reserved_quantity INTEGER NOT NULL DEFAULT 0 CHECK (reserved_quantity >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_expires_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS reservation_released_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_failure_reason TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_idempotency_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_return_requests_refund_idempotency_key ON return_requests(refund_idempotency_key) WHERE refund_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_pending_reservation ON orders(status, reservation_expires_at) WHERE status = 'PENDING_PAYMENT' AND reservation_released_at IS NULL;
