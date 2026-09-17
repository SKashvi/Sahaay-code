-- Operations: who can see what, what went wrong, what the agent said, and
-- the two pieces that were still promises rather than behaviour (offers that
-- affect the price, and bundles that are real rather than guessed).

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------
-- Two roles, not a permission system. 'operator' is the agency running the
-- deployment, 'client' is the store owner it was sold to. Existing accounts
-- become operators so an upgrade cannot lock anyone out of their own
-- dashboard, and the first client account is created deliberately.
ALTER TABLE admin_users
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'operator';

ALTER TABLE admin_users
  DROP CONSTRAINT IF EXISTS admin_users_role_check;
ALTER TABLE admin_users
  ADD CONSTRAINT admin_users_role_check CHECK (role IN ('operator', 'client'));

-- ---------------------------------------------------------------------------
-- Error log
-- ---------------------------------------------------------------------------
-- Deliberately not a general application log. This records the failures a
-- human would need to see to answer "why did the assistant do that", which
-- is a different question from "what requests did the server handle".
CREATE TABLE IF NOT EXISTS error_log (
  id          UUID PRIMARY KEY,
  source      TEXT NOT NULL,
  message     TEXT NOT NULL,
  detail      TEXT,
  -- Request shape, provider name, session id. Never a request body: those
  -- carry addresses, emails, and photo URLs.
  context     JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS error_log_created_idx ON error_log (created_at DESC);
CREATE INDEX IF NOT EXISTS error_log_source_idx ON error_log (source, created_at DESC);

-- ---------------------------------------------------------------------------
-- Bundles
-- ---------------------------------------------------------------------------
-- Until now suggest_add_ons returned the three cheapest in-stock products,
-- which is a catalog neighbour, not a combo. A bundle is a deliberate
-- pairing a human decided on, and the agent says which kind it is offering.
CREATE TABLE IF NOT EXISTS bundles (
  id          UUID PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  -- Any product in this list suggests the others.
  product_ids UUID[] NOT NULL DEFAULT '{}',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Offers that actually change the price
-- ---------------------------------------------------------------------------
-- The agent could already read offers and mention a code. Checkout ignored
-- it and charged full price, so the assistant was making a promise the
-- checkout did not keep. These columns record what was actually applied.
--
-- discount is stored in paise, like every other money value here. The order
-- total is subtotal - discount + shipping, all recomputed server side.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS offer_code TEXT;

-- A discount applies to the order, not to one line, so a return has to
-- refund the discounted price rather than the sticker price. This records
-- the ratio used at checkout so a refund months later uses the same figure
-- even if the offer has since changed or been deleted.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_ratio NUMERIC(10, 8) NOT NULL DEFAULT 1;

-- ---------------------------------------------------------------------------
-- Return photo scoring
-- ---------------------------------------------------------------------------
-- A score is advice for the reviewer, never a decision. Nothing in the code
-- reads ai_verdict to approve or reject anything.
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS ai_score INTEGER;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS ai_verdict TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;
ALTER TABLE return_requests ADD COLUMN IF NOT EXISTS ai_model TEXT;

ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS ai_score INTEGER;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS ai_verdict TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS ai_reasoning TEXT;
ALTER TABLE pending_actions ADD COLUMN IF NOT EXISTS ai_model TEXT;
