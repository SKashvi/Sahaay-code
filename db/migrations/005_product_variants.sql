-- Introduces a normalized variant per size/color combination, each with
-- its own stock. products.sizes and products.colors remain as the display
-- metadata used to build the picker UI, product_variants is the source of
-- truth for what is actually purchasable and how much of it exists.

CREATE TABLE IF NOT EXISTS product_variants (
  id              UUID PRIMARY KEY,
  product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku             TEXT NOT NULL UNIQUE,
  size            TEXT NOT NULL,
  color           TEXT NOT NULL,
  stock_quantity  INTEGER NOT NULL DEFAULT 0 CHECK (stock_quantity >= 0),
  active          BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, size, color)
);
CREATE INDEX IF NOT EXISTS idx_product_variants_product_id ON product_variants (product_id);

-- An audit trail for every manual stock change, so "why does this SKU show
-- 12 units" has an answer beyond "someone edited a number once."
CREATE TABLE IF NOT EXISTS inventory_adjustments (
  id           UUID PRIMARY KEY,
  variant_id   UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  delta        INTEGER NOT NULL, -- positive = added stock, negative = removed
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_inventory_adjustments_variant_id ON inventory_adjustments (variant_id);

-- order_items should reference exactly which variant was purchased, so a
-- return or a stock report can trace back to a real SKU. Nullable because
-- historical rows created before this migration have no variant to point
-- to, new rows always populate it (see routes/orders.js).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS variant_id UUID REFERENCES product_variants(id);

-- Backfill: every existing product's size x color combination becomes a
-- variant with a starter stock quantity, so nothing already in the
-- catalog goes silently unsellable the moment this migration runs. A real
-- deployment should treat this as a starting point and set real numbers
-- from the admin Inventory screen, not as an accurate stock count.
INSERT INTO product_variants (id, product_id, sku, size, color, stock_quantity, active)
SELECT
  gen_random_uuid(),
  p.id,
  upper(p.slug) || '-' || upper(sizes.size) || '-' || upper(regexp_replace(colors.color_obj->>'name', '[^a-zA-Z0-9]', '', 'g')),
  sizes.size,
  colors.color_obj->>'name',
  20,
  true
FROM products p
CROSS JOIN LATERAL unnest(p.sizes) AS sizes(size)
CROSS JOIN LATERAL jsonb_array_elements(p.colors) AS colors(color_obj)
ON CONFLICT (product_id, size, color) DO NOTHING;
