-- Velour production schema
-- Applied with: psql "$DATABASE_URL" -f prisma/schema.sql
-- All money columns are stored in paise (smallest INR unit) as integers to avoid
-- floating point rounding bugs. Divide by 100 only when displaying to a person.

CREATE TABLE IF NOT EXISTS admin_users (
  id             UUID PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY,
  slug        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  fabric      TEXT,
  icon_key    TEXT NOT NULL DEFAULT 'tee',
  image_url   TEXT,
  sizes       TEXT[] NOT NULL DEFAULT '{}',
  colors      JSONB NOT NULL DEFAULT '[]',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS orders (
  id                  UUID PRIMARY KEY,
  display_id          TEXT NOT NULL UNIQUE,
  customer_name       TEXT NOT NULL,
  customer_email      TEXT NOT NULL,
  customer_phone      TEXT NOT NULL,
  address_line        TEXT NOT NULL,
  city                TEXT NOT NULL,
  state               TEXT NOT NULL,
  pincode             TEXT NOT NULL,
  subtotal            INTEGER NOT NULL CHECK (subtotal >= 0),
  shipping            INTEGER NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  total               INTEGER NOT NULL CHECK (total >= 0),
  status              TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                      CHECK (status IN ('PENDING_PAYMENT','PROCESSING','SHIPPED','OUT_FOR_DELIVERY','DELIVERED','CANCELLED')),
  razorpay_order_id   TEXT UNIQUE,
  razorpay_payment_id TEXT,
  paid_at             TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_customer_email ON orders (lower(customer_email));

CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY,
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  name        TEXT NOT NULL,
  price       INTEGER NOT NULL CHECK (price >= 0),
  size        TEXT NOT NULL,
  color       TEXT NOT NULL,
  qty         INTEGER NOT NULL CHECK (qty > 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items (order_id);

CREATE TABLE IF NOT EXISTS return_requests (
  id           UUID PRIMARY KEY,
  display_id   TEXT NOT NULL UNIQUE,
  order_id     UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  reason       TEXT NOT NULL,
  description  TEXT,
  photo_url    TEXT,
  status       TEXT NOT NULL DEFAULT 'SUBMITTED'
               CHECK (status IN ('SUBMITTED','APPROVED','REJECTED','REFUNDED')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_return_requests_order_id ON return_requests (order_id);

CREATE TABLE IF NOT EXISTS knowledge_base_entries (
  id          UUID PRIMARY KEY,
  topic       TEXT NOT NULL,
  content     TEXT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id          UUID PRIMARY KEY,
  session_id  TEXT NOT NULL,
  role        TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content     TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id);
