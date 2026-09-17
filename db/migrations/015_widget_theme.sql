-- The widget's own theme, layer 3 of four.
--
-- Layer 1 is the :root defaults in public/css/widget.css, layer 2 is the
-- SAHAAY_* environment variables, this is layer 3, and layer 4 is a data-*
-- attribute on the embed script tag. Later wins. Every column is nullable on
-- purpose: NULL means "this layer has no opinion", which is what lets an admin
-- set an accent without also pinning a font they never chose.
--
-- Separate from brand_config rather than more columns on it. brand_config is
-- the storefront's palette, read by css/main.css and js/brand.js and shared
-- with pages the widget has nothing to do with. Editing a widget radius should
-- not be able to restyle the checkout page, and a storefront redesign should
-- not silently move the widget.
--
-- Single row, like brand_config and widget_settings. This build is one tenant
-- per deployment; the CHECK keeps that explicit so a second row cannot appear
-- and start being ignored silently.

CREATE TABLE IF NOT EXISTS widget_theme (
  id             INTEGER PRIMARY KEY CHECK (id = 1),

  -- Colours. Stored as written, validated as #rgb or #rrggbb before insert in
  -- src/routes/admin.js, because these are interpolated into a style
  -- attribute and a CSS custom property.
  accent         TEXT,
  accent_ink     TEXT,
  bg             TEXT,
  tint_from      TEXT,
  tint_to        TEXT,
  ink            TEXT,

  -- Pixels, stored as integers so the unit is added once at render time
  -- rather than by whoever typed the value.
  radius_shell   INTEGER CHECK (radius_shell IS NULL OR (radius_shell >= 0 AND radius_shell <= 64)),
  radius_card    INTEGER CHECK (radius_card IS NULL OR (radius_card >= 0 AND radius_card <= 48)),

  font           TEXT,
  header_style   TEXT CHECK (header_style IS NULL OR header_style IN ('floating', 'solid')),
  density        TEXT CHECK (density IS NULL OR density IN ('comfortable', 'compact')),

  -- Replaces the wordmark in the empty state. Falls back to BRAND_NAME as
  -- text when unset, so an empty state is never blank.
  logo_url       TEXT,
  greeting       TEXT,
  -- 3 to 5 starter questions. Length is enforced in the route, not here, so a
  -- bad save returns a sentence rather than a constraint violation.
  suggestions    JSONB,

  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The row exists from the start with every column NULL, so the route can
-- UPDATE without having to decide between insert and update, and so "no theme
-- saved yet" and "theme saved as all defaults" are the same thing.
INSERT INTO widget_theme (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
