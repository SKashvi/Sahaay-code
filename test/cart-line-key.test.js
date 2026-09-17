/* Run with: node test/cart-line-key.test.js
 *
 * The bug this guards against: a products block that does not carry both a
 * size and a colour produces a cart line that checkout cannot resolve.
 *
 * src/routes/orders.js resolves every posted line to a variant with the
 * composite key `${product_id}::${size}::${color}` and fails the entire
 * checkout when no variant matches. suggest_add_ons used to return only
 * id/name/price/imageUrl/inStock, so anything added from one of its cards went
 * into the cart with no size and no colour and died at the payment step.
 *
 * Two halves, both against the real source rather than a copy of it:
 *   1. tools.js builds the same product shape in every branch that emits a
 *      products block, and that shape carries sizesInStock and colorsInStock.
 *   2. widget.js turns such a product into a line whose key matches the
 *      template orders.js still uses, and refuses to build one when either
 *      half of the key is missing.
 *
 * Runs with no DATABASE_URL and no API keys.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* The format is owned by orders.js, so it is read back out of orders.js. If
 * someone changes the separator or the field order there, this test fails
 * instead of the checkout failing in production. */
function variantKeyTemplate() {
  const src = read('src/routes/orders.js');
  const match = src.match(/`\$\{v\.product_id\}::\$\{v\.size\}::\$\{v\.color\}`/);
  assert(
    match,
    'src/routes/orders.js no longer builds its variant key as `${v.product_id}::${v.size}::${v.color}` - update this test and the widget together'
  );
  return (productId, size, color) => `${productId}::${size}::${color}`;
}

/* Lifts cartLineFor and its two helpers out of widget.js and runs them against
 * stubs. widget.js is a browser IIFE that boots itself on load, so the
 * functions are extracted rather than the module being required. */
function loadWidgetCartLogic() {
  const src = read('public/js/widget.js');

  const slice = (startMarker, endMarker) => {
    const start = src.indexOf(startMarker);
    const end = src.indexOf(endMarker, start);
    assert(start > -1, `not found in widget.js: ${startMarker}`);
    assert(end > start, `not found in widget.js: ${endMarker}`);
    return src.slice(start, end);
  };

  const body = [
    slice('  function productOptions(p) {', '  function addHintText('),
    slice('  function addHintText(', '  /* Tappable chips'),
  ].join('\n');

  const state = { productChoice: {} };
  const pricePaise = (product) => {
    const exact = Number(product.pricePaise);
    if (Number.isFinite(exact)) return exact;
    const parsed = parseFloat(String(product.price == null ? '' : product.price).replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  };

  const factory = new Function(
    'state',
    'pricePaise',
    `${body}\n return { productOptions, cartLineFor, addHintText };`
  );
  return { state, ...factory(state, pricePaise) };
}

/* A card exactly as suggest_add_ons now emits one. */
const ADD_ON_PRODUCT = {
  id: '11111111-2222-3333-4444-555555555555',
  name: 'Silk Dupatta',
  slug: 'silk-dupatta',
  price: '₹1,499',
  pricePaise: 149900,
  imageUrl: 'https://example.test/dupatta.jpg',
  inStock: true,
  sizesInStock: ['Free'],
  colorsInStock: ['Indigo'],
};

function testToolsEmitOneShape() {
  const src = read('src/lib/agent/tools.js');

  // Every products block must come from the shared mapper.
  const mapped = src.match(/\.map\(toProductCard\)/g) || [];
  assert.strictEqual(mapped.length, 3, 'search_catalog and both suggest_add_ons branches must map through toProductCard');

  // And the mapper must carry both halves of the checkout key.
  const mapper = src.slice(src.indexOf('function toProductCard(row) {'), src.indexOf('function toProductResult('));
  assert(mapper.includes('sizesInStock'), 'toProductCard must carry sizesInStock');
  assert(mapper.includes('colorsInStock'), 'toProductCard must carry colorsInStock');

  // Both suggest_add_ons queries must actually select the colours, otherwise
  // the mapper defaults them to an empty array and nothing is addable.
  const addOns = src.slice(src.indexOf('async function suggestAddOns('), src.indexOf('async function requestVerification('));
  const colorAggregates = addOns.match(/array_agg\(DISTINCT v\.color\)/g) || [];
  assert.strictEqual(colorAggregates.length, 2, 'both suggest_add_ons branches must select colorsInStock');
  const sizeAggregates = addOns.match(/array_agg\(DISTINCT v\.size\)/g) || [];
  assert.strictEqual(sizeAggregates.length, 2, 'both suggest_add_ons branches must select sizesInStock');

  console.log('  ok  search_catalog and both suggest_add_ons branches emit one product shape');
}

function testAddOnProductProducesAMatchingKey() {
  const buildKey = variantKeyTemplate();
  const { productOptions, cartLineFor } = loadWidgetCartLogic();

  const { size, color } = productOptions(ADD_ON_PRODUCT);
  const line = cartLineFor(ADD_ON_PRODUCT, size, color);

  assert(line, 'a suggest_add_ons product must produce a cart line');
  assert.strictEqual(line.productId, ADD_ON_PRODUCT.id);
  assert.strictEqual(line.size, 'Free');
  assert.strictEqual(line.color, 'Indigo');
  // Paise, because renderCart and the checkout payload both divide by 100.
  assert.strictEqual(line.price, 149900);

  const key = buildKey(line.productId, line.size, line.color);
  assert.strictEqual(key, '11111111-2222-3333-4444-555555555555::Free::Indigo');

  // The shape checkout is actually posted, from app.js and widget.js alike.
  const posted = { productId: line.productId, size: line.size, color: line.color, qty: line.qty };
  assert.strictEqual(buildKey(posted.productId, posted.size, posted.color), key);
  console.log('  ok  a suggest_add_ons product yields a line item key orders.js can resolve');
}

function testUnbuyableLinesAreRefused() {
  const { cartLineFor, addHintText } = loadWidgetCartLogic();

  assert.strictEqual(cartLineFor({ ...ADD_ON_PRODUCT, colorsInStock: [] }, 'Free', ''), null, 'no colour, no line');
  assert.strictEqual(cartLineFor({ ...ADD_ON_PRODUCT, sizesInStock: [] }, '', 'Indigo'), null, 'no size, no line');
  assert.strictEqual(cartLineFor(null, 'Free', 'Indigo'), null, 'no product, no line');
  assert.strictEqual(cartLineFor({ name: 'No id' }, 'Free', 'Indigo'), null, 'no id, no line');

  // A block with no colour data at all is the pre-fix shape: it must read as
  // unavailable rather than silently adding.
  assert.strictEqual(addHintText(['Free'], [], 'Free', ''), 'Options unavailable');
  assert.strictEqual(addHintText(['S', 'M'], ['Indigo'], '', 'Indigo'), 'Choose a size');
  assert.strictEqual(addHintText(['S'], ['Indigo', 'Rust'], 'S', ''), 'Choose a colour');
  assert.strictEqual(addHintText(['S'], ['Indigo'], 'S', 'Indigo'), '');
  console.log('  ok  a line missing either half of the key is refused, not added');
}

function testMultiOptionProductWaitsForAChoice() {
  const { productOptions, cartLineFor, state } = loadWidgetCartLogic();
  const product = { ...ADD_ON_PRODUCT, sizesInStock: ['S', 'M', 'L'], colorsInStock: ['Indigo', 'Rust'] };

  let opts = productOptions(product);
  assert.strictEqual(opts.size, '', 'several sizes must not be defaulted');
  assert.strictEqual(opts.color, '', 'several colours must not be defaulted');
  assert.strictEqual(cartLineFor(product, opts.size, opts.color), null, 'nothing addable before a choice');

  state.productChoice[product.id] = { size: 'M', color: 'Rust' };
  opts = productOptions(product);
  const line = cartLineFor(product, opts.size, opts.color);
  assert(line, 'addable once both are chosen');
  assert.strictEqual(`${line.productId}::${line.size}::${line.color}`, `${product.id}::M::Rust`);
  console.log('  ok  a multi-option product is only addable once both chips are picked');
}

function main() {
  console.log('cart line keys');
  testToolsEmitOneShape();
  testAddOnProductProducesAMatchingKey();
  testUnbuyableLinesAreRefused();
  testMultiOptionProductWaitsForAChoice();
  console.log('\nAll cart line key tests passed.');
}

try {
  main();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
