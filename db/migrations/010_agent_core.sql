-- Agent core: identity for chat sessions, human-approved action proposals,
-- and the offers table the agent reads when it suggests something.
--
-- Nothing in here lets the agent move money or change an order. The agent
-- writes rows into pending_actions and stops. An admin approving one is what
-- actually creates a return or cancels an order, through the same code paths
-- the dashboard already uses.

-- ---------------------------------------------------------------------------
-- Chat sessions
-- ---------------------------------------------------------------------------
-- Convenience and audit only. The session id comes from the browser's
-- localStorage, so it is attacker-controlled and is NEVER the thing that
-- proves identity. The signed httpOnly customer_session cookie is the
-- authority (see src/middleware/customerAuth.js). These columns exist so an
-- admin can see that a session was verified and against which order.
CREATE TABLE IF NOT EXISTS chat_sessions (
  id                TEXT PRIMARY KEY,
  verified_email    TEXT,
  verified_order_id UUID REFERENCES orders(id),
  verified_at       TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Email verification codes
-- ---------------------------------------------------------------------------
-- Codes are stored hashed, never in plain text, for the same reason
-- passwords are: a database read should not hand someone a working code.
-- One row per request, single use, short expiry, capped attempts.
CREATE TABLE IF NOT EXISTS verification_codes (
  id               UUID PRIMARY KEY,
  session_id       TEXT NOT NULL,
  email            TEXT NOT NULL,
  order_display_id TEXT NOT NULL,
  order_id         UUID NOT NULL REFERENCES orders(id),
  code_hash        TEXT NOT NULL,
  attempts         INTEGER NOT NULL DEFAULT 0,
  expires_at       TIMESTAMPTZ NOT NULL,
  consumed_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_codes_session_idx
  ON verification_codes (session_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Pending actions (the agent proposes, an admin approves)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pending_actions (
  id              UUID PRIMARY KEY,
  display_id      TEXT NOT NULL UNIQUE,
  session_id      TEXT,
  order_id        UUID NOT NULL REFERENCES orders(id),
  customer_email  TEXT NOT NULL,
  kind            TEXT NOT NULL CHECK (kind IN ('RETURN', 'CANCELLATION')),
  -- What the agent is asking for: items and quantities for a return, a
  -- reason for a cancellation. Never an amount. Money is always recomputed
  -- server side at approval time from the order's real recorded prices.
  payload         JSONB NOT NULL DEFAULT '{}',
  agent_reasoning TEXT,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  review_note     TEXT,
  reviewed_at     TIMESTAMPTZ,
  reviewed_by     TEXT,
  -- Display id of whatever the approval created, e.g. RET-1A2B3C4D.
  result_ref      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pending_actions_status_idx
  ON pending_actions (status, created_at DESC);

-- ---------------------------------------------------------------------------
-- Offers
-- ---------------------------------------------------------------------------
-- Read by the agent so it can mention a real, currently active offer instead
-- of inventing one. Not applied at checkout by this migration, checkout still
-- charges what the products table says. Wiring offers into pricing is a
-- separate, deliberate change.
CREATE TABLE IF NOT EXISTS offers (
  id           UUID PRIMARY KEY,
  code         TEXT UNIQUE,
  title        TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL CHECK (kind IN ('PERCENT', 'FLAT', 'FREE_SHIPPING', 'BUNDLE')),
  -- PERCENT: whole percent off. FLAT: paise off. FREE_SHIPPING/BUNDLE: 0.
  value        INTEGER NOT NULL DEFAULT 0 CHECK (value >= 0),
  min_subtotal INTEGER NOT NULL DEFAULT 0 CHECK (min_subtotal >= 0),
  product_ids  UUID[] NOT NULL DEFAULT '{}',
  active       BOOLEAN NOT NULL DEFAULT true,
  starts_at    TIMESTAMPTZ,
  ends_at      TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Chat messages carry structured blocks now
-- ---------------------------------------------------------------------------
-- blocks is what the widget renders as product cards, order panels, upload
-- prompts and so on. The model's plain text stays in content, so an old
-- client that ignores blocks still shows a sensible conversation.
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS blocks JSONB;
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS tool_calls JSONB;

CREATE INDEX IF NOT EXISTS chat_messages_session_created_idx
  ON chat_messages (session_id, created_at DESC);
