require('dotenv').config();

const assert = require('assert');
const request = require('supertest');
const app = require('../src/app');
const db = require('../src/lib/db');
const { env } = require('../src/config/env');
const { brandConfigSchema, offerUpsertSchema } = require('../src/schemas');

async function main() {
  const agent = request(app);
  // Snapshot and blank EVERY column, not just the four this test asserts on.
  // Blanking a subset made the test depend on whatever a previous run or a
  // manual dashboard change had left in the other columns, so it passed on a
  // fresh database and failed on a used one.
  const BRAND_COLUMNS = [
    'logo_url', 'logo_dark_url', 'logo_height', 'accent', 'secondary', 'background',
    'surface', 'text_color', 'muted_color', 'border_radius', 'font_family',
    'bubble_icon', 'widget_position', 'show_cart', 'show_track_orders',
  ];
  const original = await db.query(`SELECT ${BRAND_COLUMNS.join(', ')} FROM brand_config WHERE id = 1`);
  assert.ok(original.rows.length, '011_brand_config.sql must seed row 1');
  const snapshot = original.rows[0];

  await db.query(`UPDATE brand_config SET ${BRAND_COLUMNS.map((c) => `${c} = NULL`).join(', ')} WHERE id = 1`);
  try {
    const config = await agent.get('/api/config');
    assert.equal(config.status, 200);
    assert.equal(config.body.logoUrl, env.BRAND_LOGO_URL || null);
    assert.equal(config.body.accent, env.BRAND_ACCENT);
    assert.equal(config.body.borderRadius, env.BRAND_BORDER_RADIUS);
    assert.equal(config.body.showCart, env.BRAND_SHOW_CART);
    assert.equal(config.body.shippingFreeThreshold, env.SHIPPING_FREE_THRESHOLD);
    assert.equal(config.body.shippingFlatFee, env.SHIPPING_FLAT_FEE);
    assert.ok(config.body.brand && config.body.brand.accent);

    await db.query(
      `UPDATE brand_config SET accent = '#123456', logo_url = 'https://cdn.example.test/brand.png', border_radius = 31, show_cart = false WHERE id = 1`
    );
    const merged = await agent.get('/api/config');
    assert.equal(merged.status, 200);
    assert.equal(merged.body.accent, '#123456');
    assert.equal(merged.body.logoUrl, 'https://cdn.example.test/brand.png');
    assert.equal(merged.body.borderRadius, 31);
    assert.equal(merged.body.showCart, false);
    assert.equal(merged.body.background, env.BRAND_BACKGROUND);

    assert.equal(brandConfigSchema.safeParse({ accent: '#12345G' }).success, false);
    assert.equal(brandConfigSchema.safeParse({ logoUrl: 'not-a-url' }).success, false);
    assert.equal(brandConfigSchema.safeParse({ logoUrl: 'https://example.com/logo.png' }).success, true);

    // zod's .url() alone accepts these. They reach an img src and an href,
    // so the scheme has to be pinned to http/https, not merely "valid URI".
    assert.equal(brandConfigSchema.safeParse({ logoUrl: 'javascript:alert(1)' }).success, false);
    assert.equal(brandConfigSchema.safeParse({ logoUrl: 'data:text/html,<script>x</script>' }).success, false);
    assert.equal(brandConfigSchema.safeParse({ logoDarkUrl: 'javascript:alert(1)' }).success, false);

    // The database refuses the same thing, so a seed script or a psql
    // session cannot put one in behind the API's back.
    let constraintHeld = false;
    try {
      await db.query("UPDATE brand_config SET logo_url = 'javascript:alert(1)' WHERE id = 1");
    } catch (err) {
      constraintHeld = err.code === '23514';
    }
    assert.equal(constraintHeld, true, 'the logo url check constraint must reject a javascript: scheme');

    // Offer bounds: a percentage above 100 and an end date before the start.
    assert.equal(offerUpsertSchema.safeParse({ title: 'x', kind: 'PERCENT', value: 9000 }).success, false);
    assert.equal(offerUpsertSchema.safeParse({ title: 'x', kind: 'PERCENT', value: 40 }).success, true);
    assert.equal(offerUpsertSchema.safeParse({
      title: 'x', kind: 'FLAT', value: 100,
      startsAt: '2026-12-01T00:00:00Z', endsAt: '2026-01-01T00:00:00Z',
    }).success, false);
    assert.equal(offerUpsertSchema.safeParse({ title: 'Ten off', kind: 'PERCENT', value: 10 }).success, true);
    assert.equal(offerUpsertSchema.safeParse({ title: 'Bad kind', kind: 'RANDOM', value: 10 }).success, false);

    console.log('brand config DB merge, fallback, shape, and schema checks passed');
  } finally {
    await db.query(
      `UPDATE brand_config SET ${BRAND_COLUMNS.map((c, i) => `${c} = $${i + 1}`).join(', ')} WHERE id = 1`,
      BRAND_COLUMNS.map((c) => snapshot[c])
    );
  }
  await db.pool.end();
}

main().catch(async (err) => {
  console.error('brand-config test failed:', err);
  try { await db.pool.end(); } catch (e) { /* pool may already be closed */ }
  process.exit(1);
});
