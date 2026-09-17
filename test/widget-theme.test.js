/* Run with: node test/widget-theme.test.js
 *
 * The widget's theme resolves through four layers, later winning:
 *   1. hardcoded defaults, mirrored in the :root block of css/widget.css
 *   2. SAHAAY_* environment variables
 *   3. the widget_theme row an admin edits
 *   4. data-* attributes on the embed script tag, applied in the browser
 *
 * Layers 1 to 3 are the server's, and are what this covers. The point of the
 * order is that a layer with no opinion lets the one beneath it show through,
 * which is what makes "Reset to defaults" a real reset rather than a second
 * set of hardcoded values.
 *
 * Every value here ends up inside a CSS custom property, so the validation is
 * load-bearing rather than tidiness: a colour of `red;}html{display:none`
 * would escape its declaration. A value that fails is dropped, never repaired,
 * and the layer beneath wins instead.
 */
require('dotenv').config();
const assert = require('assert');

const razorpayPath = require.resolve('../src/lib/razorpay');
require.cache[razorpayPath] = {
  id: razorpayPath, filename: razorpayPath, loaded: true,
  exports: {
    razorpay: {}, createRazorpayOrder: async () => ({ id: 'o' }),
    verifyPaymentSignature: () => true, verifyWebhookSignature: () => true,
    refundPayment: async () => ({}),
  },
};

const request = require('supertest');
const db = require('../src/lib/db');

/* The env layer is read when lib/theme.js is first required, so each case that
 * needs a different environment gets a fresh module registry. */
function loadTheme(envOverrides) {
  Object.keys(require.cache)
    .filter((key) => /src[\\/](lib[\\/]theme|config[\\/]env)\.js$/.test(key))
    .forEach((key) => { delete require.cache[key]; });
  const saved = {};
  Object.keys(envOverrides || {}).forEach((key) => {
    saved[key] = process.env[key];
    if (envOverrides[key] === undefined) delete process.env[key];
    else process.env[key] = envOverrides[key];
  });
  const mod = require('../src/lib/theme');
  return { mod, restore: () => {
    Object.keys(saved).forEach((key) => {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    });
  } };
}

async function clearThemeRow() {
  await db.query(
    `UPDATE widget_theme SET accent = NULL, accent_ink = NULL, bg = NULL, tint_from = NULL,
       tint_to = NULL, ink = NULL, radius_shell = NULL, radius_card = NULL, font = NULL,
       header_style = NULL, density = NULL, logo_url = NULL, greeting = NULL,
       suggestions = NULL WHERE id = 1`
  );
}

async function testDefaultsAloneMakeAWholeTheme() {
  await clearThemeRow();
  const { mod, restore } = loadTheme({
    SAHAAY_ACCENT: undefined, SAHAAY_INK: undefined, SAHAAY_BG: undefined,
    SAHAAY_FONT: undefined, SAHAAY_DENSITY: undefined, SAHAAY_HEADER_STYLE: undefined,
    SAHAAY_SUGGESTIONS: undefined, SAHAAY_RADIUS_SHELL: undefined,
  });
  const theme = await mod.resolveTheme();

  // A deployment that sets nothing still renders a complete theme.
  Object.keys(mod.DEFAULTS).forEach((key) => {
    assert.notStrictEqual(theme[key], undefined, `${key} must always resolve`);
  });
  assert.strictEqual(theme.accent, '#6C5FFF');
  assert.strictEqual(theme.headerStyle, 'floating', 'floating is the new default header');
  assert.strictEqual(theme.radiusShell, 24);
  restore();
  console.log('  ok  defaults alone resolve a whole theme');
}

async function testEnvOverridesDefaults() {
  await clearThemeRow();
  const { mod, restore } = loadTheme({
    SAHAAY_ACCENT: '#0E7C66',
    SAHAAY_RADIUS_SHELL: '8',
    SAHAAY_DENSITY: 'compact',
    SAHAAY_SUGGESTIONS: '["One?","Two?","Three?"]',
  });
  const theme = await mod.resolveTheme();

  assert.strictEqual(theme.accent, '#0E7C66', 'env beats the default');
  assert.strictEqual(theme.radiusShell, 8, 'and is coerced to a number');
  assert.strictEqual(theme.density, 'compact');
  assert.deepStrictEqual(theme.suggestions, ['One?', 'Two?', 'Three?']);
  // Untouched tokens still come from the defaults.
  assert.strictEqual(theme.ink, '#1A1A1A', 'an env var for one token must not blank the rest');
  restore();
  console.log('  ok  env overrides the defaults, token by token');
}

async function testRowOverridesEnvAndNullFallsThrough() {
  const { mod, restore } = loadTheme({ SAHAAY_ACCENT: '#0E7C66', SAHAAY_INK: '#202020' });
  await clearThemeRow();
  await db.query(`UPDATE widget_theme SET accent = '#B4312F' WHERE id = 1`);

  const theme = await mod.resolveTheme();
  assert.strictEqual(theme.accent, '#B4312F', 'the row beats the env var');
  // The row says nothing about ink, so the env layer below still wins. This is
  // the property that makes Reset work.
  assert.strictEqual(theme.ink, '#202020', 'a NULL column must fall through, not blank the token');

  await clearThemeRow();
  const afterReset = await mod.resolveTheme();
  assert.strictEqual(afterReset.accent, '#0E7C66', 'clearing the row hands control back to env');
  restore();
  console.log('  ok  the saved row overrides env, and a cleared column falls back through');
}

async function testHostileValuesAreDroppedNotRepaired() {
  await clearThemeRow();
  const { mod, restore } = loadTheme({ SAHAAY_ACCENT: undefined });

  // These all become CSS custom property values. Escaping the declaration is
  // the attack, so anything that could is refused outright.
  assert.strictEqual(mod.cleanColor('red;}html{display:none'), null, 'must not accept a declaration break');
  assert.strictEqual(mod.cleanColor('javascript:alert(1)'), null);
  assert.strictEqual(mod.cleanColor('rgb(1,2,3)'), null, 'hex only, so there is one shape to reason about');
  assert.strictEqual(mod.cleanColor('#ABC'), '#ABC', 'short hex is fine');
  assert.strictEqual(mod.cleanColor('  #a1b2c3  '), '#a1b2c3', 'trimmed');

  assert.strictEqual(mod.cleanFont('Inter, sans-serif'), 'Inter, sans-serif');
  assert.strictEqual(mod.cleanFont('x; } * { display:none'), null, 'no declaration break');
  assert.strictEqual(mod.cleanFont('url(https://evil.test/f.woff)'), null, 'no network request from a font value');
  assert.strictEqual(mod.cleanFont('@import "x"'), null);

  assert.strictEqual(mod.cleanUrl('https://cdn.test/logo.png'), 'https://cdn.test/logo.png');
  assert.strictEqual(mod.cleanUrl('javascript:alert(1)'), null, 'this becomes an img src');
  assert.strictEqual(mod.cleanUrl('data:text/html,<script>'), null);

  assert.strictEqual(mod.cleanRadius('999', 64), null, 'out of range is no opinion, not a clamp');
  assert.strictEqual(mod.cleanRadius('-4', 64), null);
  assert.strictEqual(mod.cleanRadius('16', 64), 16);

  // Wrong length is no opinion at all rather than a partial list.
  assert.strictEqual(mod.cleanSuggestions(['only', 'two']), null);
  assert.strictEqual(mod.cleanSuggestions(['1', '2', '3', '4', '5', '6']), null);
  assert.strictEqual(mod.cleanSuggestions('not json'), null, 'a malformed env var must not crash boot');
  assert.deepStrictEqual(mod.cleanSuggestions('["a","b","c"]'), ['a', 'b', 'c']);
  restore();
  console.log('  ok  values that could escape a CSS declaration are dropped, not repaired');
}

async function testCssTextIsSafeAndComplete() {
  await clearThemeRow();
  const { mod, restore } = loadTheme({ SAHAAY_ACCENT: '#0E7C66' });
  const theme = await mod.resolveTheme();
  const css = mod.themeToCssText(theme);

  assert.ok(css.includes('--sah-accent:#0E7C66'));
  assert.ok(css.includes('--sah-ink-muted:color-mix'), 'derived tokens come from the base ones');
  assert.ok(css.includes('--sah-radius-shell:24px'), 'radii carry their unit');
  // This string is inlined into a <style> block before first paint, so it must
  // not be able to close it.
  assert.ok(!css.includes('</'), 'must not be able to close a style element');
  assert.ok(!css.includes('{') && !css.includes('}'), 'declarations only, no blocks');
  restore();
  console.log('  ok  the inlined cssText carries every token and cannot break out');
}

async function testWidgetConfigEndpointServesTheTheme() {
  await clearThemeRow();
  await db.query(`UPDATE widget_theme SET accent = '#B4312F', density = 'compact' WHERE id = 1`);
  // The app caches nothing here, so a fresh require is not needed.
  const app = require('../src/app');
  const res = await request(app).get('/api/widget/config');

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.theme.accent, '#B4312F');
  assert.strictEqual(res.body.theme.density, 'compact');
  assert.ok(res.body.cssText.includes('--sah-accent:#B4312F'), 'cssText is ready to inline');
  // Everything /api/config returns is still here, so the widget makes one
  // request rather than two.
  assert.ok(res.body.brandName, 'brand fields come along');
  assert.ok(res.body.brand, 'and the nested brand object the widget reads');
  assert.notStrictEqual(res.body.shippingFreeThreshold, undefined);

  const plain = await request(app).get('/api/config');
  assert.strictEqual(plain.status, 200);
  assert.strictEqual(plain.body.theme, undefined, '/api/config is unchanged for the storefront');
  await clearThemeRow();
  console.log('  ok  GET /api/widget/config serves the theme alongside the existing config');
}

async function main() {
  console.log('widget theme');
  await testDefaultsAloneMakeAWholeTheme();
  await testEnvOverridesDefaults();
  await testRowOverridesEnvAndNullFallsThrough();
  await testHostileValuesAreDroppedNotRepaired();
  await testCssTextIsSafeAndComplete();
  await testWidgetConfigEndpointServesTheTheme();
  console.log('\nAll widget theme tests passed.');
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
