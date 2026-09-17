/* Run with: node test/widget-cart-bridge.test.js
 *
 * The bug: public/js/api.js is loaded as a classic script, so its top level
 * `const Cart = {...}` lives in script scope and never becomes a property of
 * window. app.js and admin.js are classic scripts too, so they pick it up
 * through the shared global lexical scope and nothing looked wrong. The chat
 * widget runs inside an IIFE and reaches for window.Cart, which was undefined,
 * so cartLines() fell through to [] and its Add button wrote nowhere.
 *
 * Both halves are covered here, in a real DOM:
 *   1. api.js puts Cart (and API) on window, so the host page contract holds.
 *   2. the widget's adapter writes to the same storage the storefront reads,
 *      through the host global when there is one, through a SahaayCart bridge
 *      when the host provides one, and through localStorage alone when the
 *      page has neither - which is every client site the embed ships to.
 *
 * Runs with no DATABASE_URL and no API keys.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CART_KEY = 'velour_cart';

/* A page with a working localStorage. jsdom supplies one, but it is reset per
 * document, which is exactly the isolation each case below wants. */
function makePage() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'https://shop.example.test/',
    pretendToBeVisual: true,
    // outside-only gives window.eval a real page global, which is the whole
    // point: api.js has to be evaluated the way a browser evaluates a classic
    // script, not wrapped in a module scope.
    runScripts: 'outside-only',
  });
  return dom;
}

/* Loads api.js the way a browser loads a classic script: evaluated with the
 * window as its global, not wrapped in a module or an IIFE. That is the whole
 * point, because the wrapping is what the bug was about. */
function loadApiJs(dom) {
  dom.window.eval(read('public/js/api.js'));
}

/* The widget's cart adapter, lifted out of the IIFE and run against the page's
 * globals. The widget's own boot path needs shadow DOM, fetch and /api/config,
 * none of which this is about. */
function loadWidgetCart(dom) {
  const src = read('public/js/widget.js');
  const start = src.indexOf('  const CART_KEY =');
  const end = src.indexOf('  function refreshCart()');
  assert(start > -1 && end > start, 'widget.js cart adapter not found - has it been renamed?');
  const body = src.slice(start, end);
  const factory = dom.window.eval(`(function () { ${body}\n return { cartStore, cartLines }; })`);
  return factory();
}

const PRODUCT = { id: 'p-1', name: 'Cotton Kurta', price: 129900, imageUrl: 'https://x.test/a.jpg' };

function storedCart(dom) {
  return JSON.parse(dom.window.localStorage.getItem(CART_KEY) || '[]');
}

function testApiJsExportsTheCart() {
  const dom = makePage();
  loadApiJs(dom);

  assert.strictEqual(typeof dom.window.Cart, 'object', 'api.js must put Cart on window');
  assert.strictEqual(typeof dom.window.Cart.add, 'function', 'window.Cart must be the real cart');
  // window.API was broken by the same scoping rule, and the widget's checkout
  // reads it.
  assert.strictEqual(typeof dom.window.API, 'object', 'api.js must put API on window');
  assert.strictEqual(typeof dom.window.API.checkout, 'function');
  // This one always worked: a function declaration does become a window
  // property, which is why the breakage was easy to miss.
  assert.strictEqual(typeof dom.window.formatPaise, 'function');
  console.log('  ok  api.js exports Cart and API onto window');
}

function testWidgetWritesTheCartTheStorefrontReads() {
  const dom = makePage();
  loadApiJs(dom);
  const widget = loadWidgetCart(dom);

  // The storefront's own view of an empty cart.
  assert.strictEqual(dom.window.Cart.get().length, 0);
  assert.strictEqual(widget.cartLines().length, 0, 'widget starts from the same empty cart');

  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);

  // The assertion that would have failed before the fix: the storefront sees
  // what the widget wrote.
  const fromStorefront = dom.window.Cart.get();
  assert.strictEqual(fromStorefront.length, 1, 'the storefront must see the widget\'s line');
  assert.strictEqual(fromStorefront[0].productId, 'p-1');
  assert.strictEqual(fromStorefront[0].size, 'M');
  assert.strictEqual(fromStorefront[0].color, 'Indigo');
  assert.strictEqual(fromStorefront[0].qty, 1);
  assert.strictEqual(fromStorefront[0].price, 129900, 'paise, the unit the storefront totals in');
  assert.strictEqual(dom.window.Cart.count(), 1);
  assert.strictEqual(dom.window.Cart.subtotal(), 129900);

  // And the reverse: a storefront write is visible to the widget.
  dom.window.Cart.add({ id: 'p-2', name: 'Silk Dupatta', price: 49900 }, 'Free', 'Rust', 2);
  assert.strictEqual(widget.cartLines().length, 2, 'the widget must see the storefront\'s line');
  console.log('  ok  the widget Add button writes the cart the storefront reads, both ways');
}

function testAddingTheSameLineMerges() {
  const dom = makePage();
  loadApiJs(dom);
  const widget = loadWidgetCart(dom);

  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  widget.cartStore.add(PRODUCT, 'L', 'Indigo', 1);

  const lines = dom.window.Cart.get();
  assert.strictEqual(lines.length, 2, 'same product/size/colour is one line');
  assert.strictEqual(lines.find((l) => l.size === 'M').qty, 2, 'quantities add');
  assert.strictEqual(lines.find((l) => l.size === 'L').qty, 1, 'a different size is its own line');
  console.log('  ok  repeat adds merge exactly as api.js merges them');
}

function testStandaloneEmbedWithNoHostGlobals() {
  // A client site: the embed is the only script we control. No api.js, so no
  // window.Cart and no window.API. This is the path that has to work alone.
  const dom = makePage();
  assert.strictEqual(dom.window.Cart, undefined, 'this page deliberately has no host cart');
  const widget = loadWidgetCart(dom);

  assert.strictEqual(widget.cartLines().length, 0);
  const written = widget.cartStore.add(PRODUCT, 'S', 'Black', 3);
  assert.strictEqual(written, true, 'the localStorage path must report success');

  assert.strictEqual(widget.cartLines().length, 1, 'the widget reads back its own write');
  // Written under the same key api.js uses, so if the host page ever does load
  // api.js the two agree instead of keeping separate carts.
  const raw = storedCart(dom);
  assert.strictEqual(raw.length, 1, `must persist under ${CART_KEY}`);
  assert.strictEqual(raw[0].qty, 3);
  assert.strictEqual(raw[0].color, 'Black');
  console.log('  ok  a standalone embed with no host globals still writes a real cart');
}

function testSahaayCartBridgeWins() {
  // A host page that owns its own cart implements this and the widget defers
  // to it, rather than writing a second cart into localStorage behind it.
  const dom = makePage();
  loadApiJs(dom);
  const seen = [];
  dom.window.SahaayCart = {
    get: () => seen.slice(),
    add: (product, size, color, qty) => { seen.push({ productId: product.id, size, color, qty }); },
    clear: () => { seen.length = 0; },
  };
  const widget = loadWidgetCart(dom);

  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  assert.strictEqual(seen.length, 1, 'the bridge must receive the add');
  assert.strictEqual(widget.cartLines().length, 1, 'and be read back through');
  // The bridge owns the cart, so nothing may leak past it.
  assert.strictEqual(storedCart(dom).length, 0, 'the bridge must not be shadowed by a localStorage write');
  assert.strictEqual(dom.window.Cart.get().length, 0, 'nor by a write to the host cart');
  console.log('  ok  a SahaayCart bridge takes precedence over both fallbacks');
}

function testBridgeIsResolvedPerCallNotAtLoad() {
  // The widget script can run before the page's own scripts have defined
  // either global, so resolving once at load would pin the wrong backend.
  const dom = makePage();
  const widget = loadWidgetCart(dom);

  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  assert.strictEqual(storedCart(dom).length, 1, 'with no host yet, it uses localStorage');

  loadApiJs(dom);
  assert.strictEqual(widget.cartLines().length, 1, 'the host cart picks up what was already stored');
  widget.cartStore.add({ id: 'p-3', name: 'Scarf', price: 19900 }, 'Free', 'Green', 1);
  assert.strictEqual(dom.window.Cart.get().length, 2, 'later adds go through the host that has since appeared');
  console.log('  ok  the backend is resolved per call, so a late-loading host still wins');
}

function testCartChangeEventFires() {
  // The widget re-renders its cart panel on this event, and api.js dispatches
  // the same one, so a write from either side notifies the other.
  const dom = makePage();
  const widget = loadWidgetCart(dom);
  let fired = 0;
  dom.window.document.addEventListener('velour:cart-change', () => { fired += 1; });

  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  assert.strictEqual(fired, 1, 'the localStorage path must announce its write');

  widget.cartStore.clear();
  assert.strictEqual(fired, 2, 'clearing announces too');
  assert.strictEqual(storedCart(dom).length, 0);
  console.log('  ok  velour:cart-change fires on the localStorage path as well');
}

/* 2B: the badge is driven by an event, and every mutation emits it.
 *
 * window.Cart exists now, but nothing re-rendered when it changed, so the
 * count sat at whatever it was when the header was last drawn. There is no
 * server-side cart in this build: api.js keeps it in localStorage and the
 * widget's adapter is the fallback for a page that never loads api.js, so
 * those two are the only write paths there are. */
function testEveryMutationEmitsCartChange() {
  const dom = makePage();
  loadApiJs(dom);
  const widget = loadWidgetCart(dom);

  const seen = [];
  dom.window.document.addEventListener('cart:change', (e) => seen.push(e.detail && e.detail.count));

  // From a product card quick-add in the widget.
  widget.cartStore.add(PRODUCT, 'M', 'Indigo', 1);
  assert.strictEqual(seen.length, 1, 'an add from the widget emits');
  assert.strictEqual(seen[0], 1, 'and carries the count, so a badge needs no second read');

  // From the storefront.
  dom.window.Cart.add({ id: 'p-2', name: 'Dupatta', price: 49900 }, 'Free', 'Rust', 2);
  assert.strictEqual(seen.length, 2, 'an add from the storefront emits');
  assert.strictEqual(seen[1], 3, 'the count is quantities, not lines');

  // Quantity updates and removals, which are storefront-only operations.
  dom.window.Cart.updateQty(0, 1);
  assert.strictEqual(seen[seen.length - 1], 4, 'a quantity change emits the new count');
  dom.window.Cart.remove(0);
  assert.strictEqual(seen[seen.length - 1], 2, 'a removal emits too');
  dom.window.Cart.clear();
  assert.strictEqual(seen[seen.length - 1], 0, 'and clearing emits zero');

  // The old event name still fires, so nothing that listened for it breaks.
  const legacy = [];
  dom.window.document.addEventListener('velour:cart-change', () => legacy.push(1));
  widget.cartStore.add(PRODUCT, 'S', 'Black', 1);
  assert.strictEqual(legacy.length, 1, 'velour:cart-change still fires alongside cart:change');
  console.log('  ok  every add, quantity change, removal and clear emits cart:change with the count');
}

/* A page navigation does not carry the widget's DOM, but the cart lives in
 * localStorage and the chat log in sessionStorage, so the count on the next
 * page has to come back from storage rather than from memory. */
function testCountSurvivesAPageNavigation() {
  const first = makePage();
  loadApiJs(first);
  const widgetA = loadWidgetCart(first);
  widgetA.cartStore.add(PRODUCT, 'M', 'Indigo', 2);
  const stored = first.window.localStorage.getItem(CART_KEY);
  assert.ok(stored, 'the cart is in localStorage, not in the widget');

  // A fresh document, as a navigation gives you, with the same origin storage.
  const second = makePage();
  second.window.localStorage.setItem(CART_KEY, stored);
  loadApiJs(second);
  const widgetB = loadWidgetCart(second);

  assert.strictEqual(second.window.Cart.count(), 2, 'the storefront reads the count back');
  const lines = widgetB.cartLines();
  assert.strictEqual(lines.reduce((sum, l) => sum + l.qty, 0), 2, 'and so does the widget');
  console.log('  ok  the count comes back from storage after a page navigation');
}

function main() {
  console.log('widget cart bridge');
  testApiJsExportsTheCart();
  testWidgetWritesTheCartTheStorefrontReads();
  testAddingTheSameLineMerges();
  testStandaloneEmbedWithNoHostGlobals();
  testSahaayCartBridgeWins();
  testBridgeIsResolvedPerCallNotAtLoad();
  testCartChangeEventFires();
  testEveryMutationEmitsCartChange();
  testCountSurvivesAPageNavigation();
  console.log('\nAll widget cart bridge tests passed.');
}

try {
  main();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
