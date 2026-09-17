const express = require('express');
const { env } = require('../config/env');
const db = require('../lib/db');

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

router.get('/', async (req, res, next) => {
  try {
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

    res.json({
      brandName: env.BRAND_NAME,
      brandTagline: env.BRAND_TAGLINE,
      brand,
      ...brand,
      shippingFreeThreshold: env.SHIPPING_FREE_THRESHOLD,
      shippingFlatFee: env.SHIPPING_FLAT_FEE,
      welcomeMessage: row?.welcomeMessage || 'Hi! How can I help you today?',
      suggestedQuestions: row?.suggestedQuestions || [],
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
