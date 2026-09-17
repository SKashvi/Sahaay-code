require('dotenv').config();

const REQUIRED = [
  'DATABASE_URL',
  'JWT_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'AI_PROVIDER',
  'AI_API_KEY',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
];

const missing = REQUIRED.filter((key) => !process.env[key] || process.env[key].trim() === '');

if (missing.length) {
  // Fail loudly at boot rather than limping along with an undefined secret
  // somewhere, which is how half-configured deployments end up insecure.
  console.error('Missing required environment variables: ' + missing.join(', '));
  console.error('Copy .env.example to .env and fill every value in before starting the server.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production') {
  if (process.env.EMAIL_PROVIDER !== 'resend' || !process.env.EMAIL_API_KEY || !process.env.EMAIL_FROM_ADDRESS) {
    console.error('Production requires EMAIL_PROVIDER=resend, EMAIL_API_KEY, and EMAIL_FROM_ADDRESS so customer notifications are real.');
    process.exit(1);
  }
}

if (process.env.NODE_ENV === 'production' && process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET must be at least 32 characters in production. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: Number(process.env.PORT) || 4000,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_SSL: process.env.DATABASE_SSL === 'true',
  DATABASE_SSL_INSECURE: process.env.DATABASE_SSL_INSECURE === 'true',
  JWT_SECRET: process.env.JWT_SECRET,
  CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:8080',

  // Vision is configured separately from chat because the cheap text models
  // cannot see images. Blank means photo scoring is off, which is supported.
  AI_VISION_PROVIDER: process.env.AI_VISION_PROVIDER || '',
  AI_VISION_API_KEY: process.env.AI_VISION_API_KEY || '',
  AI_VISION_MODEL: process.env.AI_VISION_MODEL || '',
  BRAND_NAME: process.env.BRAND_NAME || 'Your Store',
  BRAND_ACCENT: process.env.BRAND_ACCENT || '#6C5FFF',
  BRAND_TAGLINE: process.env.BRAND_TAGLINE || 'Your AI shopping assistant',
  BRAND_LOGO_URL: process.env.BRAND_LOGO_URL || '',
  BRAND_LOGO_DARK_URL: process.env.BRAND_LOGO_DARK_URL || '',
  BRAND_LOGO_HEIGHT: Number(process.env.BRAND_LOGO_HEIGHT) || 52,
  BRAND_SECONDARY: process.env.BRAND_SECONDARY || '#171310',
  BRAND_BACKGROUND: process.env.BRAND_BACKGROUND || '#F7F3EF',
  BRAND_SURFACE: process.env.BRAND_SURFACE || '#FFFFFF',
  BRAND_TEXT_COLOR: process.env.BRAND_TEXT_COLOR || '#171310',
  BRAND_MUTED_COLOR: process.env.BRAND_MUTED_COLOR || '#746D68',
  BRAND_BORDER_RADIUS: Number(process.env.BRAND_BORDER_RADIUS) || 18,
  BRAND_FONT_FAMILY: process.env.BRAND_FONT_FAMILY || 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  BRAND_BUBBLE_ICON: process.env.BRAND_BUBBLE_ICON || 'chat',
  BRAND_WIDGET_POSITION: process.env.BRAND_WIDGET_POSITION || 'bottom-right',
  BRAND_SHOW_CART: process.env.BRAND_SHOW_CART !== 'false',
  BRAND_SHOW_TRACK_ORDERS: process.env.BRAND_SHOW_TRACK_ORDERS !== 'false',

  /* Widget theme, layer 2 of the resolution order.
   *
   * Layer 1 is the hardcoded default in each of these lines and in the :root
   * block of css/widget.css; layer 3 is the widget_theme row an admin edits;
   * layer 4 is a data-* attribute on the embed script tag. Later wins, and
   * every one of them is optional, so a deployment that sets none of these
   * still renders a complete theme.
   *
   * Kept out of BRAND_* deliberately: those names are the storefront's
   * palette and the widget's old contract, and are still read by css/main.css
   * and brand.js. These are the widget's own token set, which is why they can
   * be changed without touching the storefront.
   */
  SAHAAY_ACCENT: process.env.SAHAAY_ACCENT || '',
  SAHAAY_ACCENT_INK: process.env.SAHAAY_ACCENT_INK || '',
  SAHAAY_BG: process.env.SAHAAY_BG || '',
  SAHAAY_TINT_FROM: process.env.SAHAAY_TINT_FROM || '',
  SAHAAY_TINT_TO: process.env.SAHAAY_TINT_TO || '',
  SAHAAY_INK: process.env.SAHAAY_INK || '',
  SAHAAY_RADIUS_SHELL: process.env.SAHAAY_RADIUS_SHELL || '',
  SAHAAY_RADIUS_CARD: process.env.SAHAAY_RADIUS_CARD || '',
  SAHAAY_FONT: process.env.SAHAAY_FONT || '',
  SAHAAY_HEADER_STYLE: process.env.SAHAAY_HEADER_STYLE || '',
  SAHAAY_DENSITY: process.env.SAHAAY_DENSITY || '',
  SAHAAY_LOGO_URL: process.env.SAHAAY_LOGO_URL || '',
  SAHAAY_GREETING: process.env.SAHAAY_GREETING || '',
  // A JSON array of 3 to 5 strings. Parsed and validated in lib/theme.js, so
  // a malformed value degrades to the default rather than crashing boot.
  SAHAAY_SUGGESTIONS: process.env.SAHAAY_SUGGESTIONS || '',

  SHIPPING_FREE_THRESHOLD: Number(process.env.SHIPPING_FREE_THRESHOLD) || 199900,
  SHIPPING_FLAT_FEE: Number(process.env.SHIPPING_FLAT_FEE) || 9900,

  RAZORPAY_KEY_ID: process.env.RAZORPAY_KEY_ID,
  RAZORPAY_KEY_SECRET: process.env.RAZORPAY_KEY_SECRET,
  RAZORPAY_WEBHOOK_SECRET: process.env.RAZORPAY_WEBHOOK_SECRET,

  // No provider is hardcoded, see src/lib/ai-providers. AI_PROVIDER picks
  // which one, AI_MODEL is passed straight through to it (each provider
  // has its own sensible default if this is left blank). The optional
  // fallback is only used for retryable failures (timeout, rate limit,
  // upstream 5xx), never for a bad API key or a real 400.
  AI_PROVIDER: process.env.AI_PROVIDER,
  AI_API_KEY: process.env.AI_API_KEY,
  AI_MODEL: process.env.AI_MODEL || '',
  AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS || '5000',
  AI_FALLBACK_PROVIDER: process.env.AI_FALLBACK_PROVIDER || '',
  AI_FALLBACK_API_KEY: process.env.AI_FALLBACK_API_KEY || '',
  AI_FALLBACK_MODEL: process.env.AI_FALLBACK_MODEL || '',

  S3_BUCKET: process.env.S3_BUCKET,
  S3_REGION: process.env.S3_REGION,
  S3_ACCESS_KEY_ID: process.env.S3_ACCESS_KEY_ID,
  S3_SECRET_ACCESS_KEY: process.env.S3_SECRET_ACCESS_KEY,
  S3_ENDPOINT: process.env.S3_ENDPOINT || undefined,
  S3_PUBLIC_BASE_URL: process.env.S3_PUBLIC_BASE_URL || '',
};

module.exports = { env };
