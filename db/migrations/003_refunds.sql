-- Tracks an actual Razorpay refund against a return request, so "REFUNDED"
-- in the admin dashboard corresponds to a real refund that actually
-- happened, not just a status label someone clicked.

ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS razorpay_refund_id TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_amount INTEGER;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMPTZ;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS refund_error TEXT;
