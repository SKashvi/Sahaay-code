-- One customer-facing brand row. Nullable fields let the API fall back to
-- validated environment values without forcing every deployment to fill
-- every design token in the database.
CREATE TABLE IF NOT EXISTS brand_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  logo_url TEXT,
  logo_dark_url TEXT,
  logo_height INTEGER,
  accent TEXT,
  secondary TEXT,
  background TEXT,
  surface TEXT,
  text_color TEXT,
  muted_color TEXT,
  border_radius INTEGER,
  font_family TEXT,
  bubble_icon TEXT,
  widget_position TEXT,
  show_cart BOOLEAN,
  show_track_orders BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO brand_config (
  id, logo_height, accent, secondary, background, surface, text_color,
  muted_color, border_radius, font_family, bubble_icon, widget_position,
  show_cart, show_track_orders
) VALUES (
  1, 52, '#6C5FFF', '#171310', '#F7F3EF', '#FFFFFF', '#171310',
  '#746D68', 18,
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  'chat', 'bottom-right', true, true
)
ON CONFLICT (id) DO NOTHING;
