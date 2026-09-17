const express = require('express');
const { env } = require('../config/env');
const db = require('../lib/db');

const { resolveTheme, themeToCssText } = require('../lib/theme');

const router = express.Router();

const DEFAULT_BRAND = {
  logoUrl: env.BRAND_LOGO_URL || null,
  logoDarkUrl: env.BRAND_LOGO_DARK_URL || null,
  logoHeight: env.BRAND_LOGO_HEIGHT,
  accent: env.BRAND_ACCENT,
  secondary: env.BRAND_SECONDARY,
  background: env.BRAND_BACKGROUND,
  surface: env.BRAND_SURFACE,
  textColor: env.BRAND_TEXT_COLOR,
  mutedColor: env.BRAND_MUTED_COLOR,
  borderRadius: env.BRAND_BORDER_RADIUS,
  fontFamily: env.BRAND_FONT_FAMILY,
  bubbleIcon: env.BRAND_BUBBLE_ICON,
  widgetPosition: env.BRAND_WIDGET_POSITION,
  showCart: env.BRAND_SHOW_CART,
  showTrackOrders: env.BRAND_SHOW_TRACK_ORDERS,
};

async function buildConfig() {
  const settings = await db.query(
    `SELECT welcome_message AS "welcomeMessage", suggested_questions AS "suggestedQuestions"
       FROM widget_settings WHERE id = 1`
  );
  const brandResult = await db.query(
    `SELECT logo_url AS "logoUrl", logo_dark_url AS "logoDarkUrl", logo_height AS "logoHeight",
            accent, secondary, background, surface, text_color AS "textColor",
            muted_color AS "mutedColor", border_radius AS "borderRadius",
            font_family AS "fontFamily", bubble_icon AS "bubbleIcon",
            widget_position AS "widgetPosition", show_cart AS "showCart",
            show_track_orders AS "showTrackOrders"
       FROM brand_config WHERE id = 1`
  );
  const row = settings.rows[0];
  const dbBrand = brandResult.rows[0] || {};
  const brand = Object.fromEntries(Object.keys(DEFAULT_BRAND).map((key) => [key,
    dbBrand[key] !== null && dbBrand[key] !== undefined ? dbBrand[key] : DEFAULT_BRAND[key],
  ]));

  return {
    brandName: env.BRAND_NAME,
    brandTagline: env.BRAND_TAGLINE,
    brand,
    ...brand,
    shippingFreeThreshold: env.SHIPPING_FREE_THRESHOLD,
    shippingFlatFee: env.SHIPPING_FLAT_FEE,
    welcomeMessage: row?.welcomeMessage || 'Hi! How can I help you today?',
    suggestedQuestions: row?.suggestedQuestions || [],
  };
}

router.get('/', async (req, res, next) => {
  try {
    res.json(await buildConfig());
  } catch (err) {
    next(err);
  }
});

/* The widget's own config, theme included.
 *
 * Separate from GET /api/config, which the storefront pages read and which
 * carries the BRAND_* palette css/main.css consumes. The widget needs those
 * fields too, so everything /api/config returns is returned here as well and
 * the theme is added alongside; nothing that already reads /api/config has to
 * change, and the widget makes one request rather than two.
 *
 * cssText is the resolved theme already written as CSS declarations. The embed
 * inlines it before first paint so there is no unstyled frame, which is the
 * same problem the brand-flash fix solved for the storefront: a value that
 * arrives after the first paint is a value the customer watches change.
 */
async function widgetConfig(req, res, next) {
  try {
    const [base, theme] = await Promise.all([buildConfig(), resolveTheme()]);
    res.json({
      ...base,
      theme,
      // Ready to drop into a style attribute. Every value in it has been
      // validated in lib/theme.js, because this string becomes CSS.
      cssText: themeToCssText(theme),
    });
  } catch (err) {
    next(err);
  }
}

// Reachable as GET /api/widget/config, which is what the embed asks for, and
// as GET /api/config/widget, because this router is already mounted there and
// a second path costs nothing.
router.get('/widget', widgetConfig);
router.get('/config', widgetConfig);

module.exports = router;
