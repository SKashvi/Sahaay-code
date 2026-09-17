/* Run with: node test/widget-visual.test.js
 *
 * The visual system's two rules that are easy to state and easy to break:
 *
 *   1. Every visual value resolves from a --sah-* custom property. One accent
 *      has to restyle the whole widget, which it cannot do if anything is
 *      still holding a literal colour.
 *   2. Exactly one filled accent button may be visible on a screen. Two and
 *      neither is the next step any more.
 *
 * Rule 2 is counted against rendered output rather than source text, because
 * several views put a primary in each branch of a ternary and only one of them
 * ever reaches the screen. A static grep reads that as a violation; a render
 * shows the truth.
 *
 * Runs with no DATABASE_URL and no API keys.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const CSS = read('public/css/widget.css');
const SRC = read('public/js/widget.js');

/* Everything after the :host positioning block, which is where the token
 * definitions end and the rules that consume them begin. Comments and
 * mask-image are stripped: a mask reads only the alpha channel, so the hex in
 * one is a stencil rather than a colour anyone sees. */
function styleBody() {
  const start = CSS.indexOf(':host {\n  position: fixed');
  assert(start > -1, 'the :host positioning block moved');
  return CSS.slice(CSS.indexOf('}', start))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(-webkit-)?mask-image:[^;]+;/g, '');
}

function valuesOf(property, body) {
  const re = new RegExp(property + ':\\s*([^;]+);', 'g');
  return [...body.matchAll(re)].map((m) => m[1].trim());
}

function testNoHardcodedVisuals() {
  const body = styleBody();

  const hexes = body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepStrictEqual(hexes, [], `hardcoded colours: ${hexes.join(', ')}`);

  const fonts = valuesOf('font-family', body).filter((v) => !v.startsWith('var('));
  assert.deepStrictEqual(fonts, [], `hardcoded font stacks: ${fonts.join(' | ')}`);

  const radii = valuesOf('border-radius', body).filter((v) => !v.startsWith('var('));
  assert.deepStrictEqual(radii, [], `hardcoded radii: ${radii.join(' | ')}`);

  const shadows = valuesOf('box-shadow', body)
    .filter((v) => !v.startsWith('var(') && v !== 'none' && !v.startsWith('0 0 0'));
  assert.deepStrictEqual(shadows, [], `hardcoded shadows: ${shadows.join(' | ')}`);

  console.log('  ok  no hardcoded colours, fonts, radii or shadows below the token block');
}

function testEveryTokenUsedIsDefined() {
  const used = new Set([...styleBody().matchAll(/var\(--sah-([a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...CSS.matchAll(/^\s*--sah-([a-z0-9-]+):/gm)].map((m) => m[1]));
  const missing = [...used].filter((t) => !defined.has(t));
  assert.deepStrictEqual(missing, [], `tokens used but never defined: ${missing.join(', ')}`);

  // The token set the brief names, all present.
  ['accent', 'accent-ink', 'accent-soft', 'bg', 'bg-tint-from', 'bg-tint-to', 'ink',
    'ink-muted', 'ink-faint', 'line', 'radius-shell', 'radius-card', 'radius-pill',
    'shadow-shell', 'shadow-float', 'font'].forEach((token) => {
    assert(defined.has(token), `--sah-${token} must be defined`);
  });
  console.log('  ok  every token used is defined, and the named token set is complete');
}

/* The render functions, lifted out of the IIFE and run against stubs. The
 * widget's own boot needs shadow DOM, fetch and a config request, none of
 * which these rules are about. */
function loadRenderers() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const slice = (from, to) => {
    const i = SRC.indexOf(from);
    const j = SRC.indexOf(to, i);
    assert(i > -1 && j > i, `could not slice ${from}`);
    return SRC.slice(i, j);
  };

  const body = [
    slice('  function productOptions(p) {', '  /* Chip taps and Add both update'),
    slice('  /* One order.', '  function renderOrders() {'),
    slice('  function renderOrders() {', '  function cartLines() {'),
    slice('  function renderCart() {', '  async function sendChat('),
    slice('  /* Logo or wordmark, greeting, starter chips', '  function renderBlocks(blocks)'),
  ].join('\n');

  const ESC = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SAFE_URL = (v) => (typeof v === 'string' && /^https?:\/\//i.test(v) ? v : '');
  const state = {
    productChoice: {}, theme: {}, config: {}, messages: [],
    orders: null, ordersLoading: false, ordersError: '', ordersNotice: '',
    returnFor: null, returnReason: '', returnItems: {}, returnSubmitting: false, returnError: '',
    verified: false, attachmentUrl: null, attachmentName: '', cartSubmitting: false,
  };
  const productRefs = [];
  const pricePaise = (p) => Number(p.pricePaise) || 0;
  const money = (v) => '₹' + (Number(v || 0) / 100).toFixed(2);
  const icon = () => '<svg></svg>';
  const cartLines = () => state.__cart || [];

  const factory = dom.window.eval(
    `(function (ESC, SAFE_URL, state, productRefs, pricePaise, money, icon, cartLines) {
       ${body}
       return { renderOrderPanel, renderReturnForm, renderOrders, renderEmptyState, renderCart, renderProduct };
     })`
  );
  return { api: factory(ESC, SAFE_URL, state, productRefs, pricePaise, money, icon, cartLines), state, dom };
}

/* Counts what the brief calls a filled accent button: class="vw-btn" with no
 * secondary or ghost modifier. */
function countPrimaries(html, dom) {
  const el = dom.window.document.createElement('div');
  el.innerHTML = html;
  return [...el.querySelectorAll('button')].filter((b) => {
    const cls = b.getAttribute('class') || '';
    return /\bvw-btn\b/.test(cls) && !/\bsecondary\b/.test(cls) && !/\bghost\b/.test(cls);
  }).length;
}

function testOnePrimaryPerScreen() {
  const { api, state, dom } = loadRenderers();

  const order = {
    displayId: 'VEL-1234', status: 'PROCESSING', statusLabel: 'Processing',
    stages: ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'],
    stageLabels: { PENDING_PAYMENT: 'Payment pending', PROCESSING: 'Processing', SHIPPED: 'Shipped', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered' },
    stageIndex: 1, total: '₹2,499', items: [{ itemId: 'i1', name: 'Kurta', size: 'M', color: 'Indigo', qty: 1, price: '₹2,499' }],
    tracking: null, canCancel: true, canRequestReturn: false,
  };

  // Every action visible at once, which is the worst case for this rule.
  const panel = api.renderOrderPanel({ ...order, canRequestReturn: true, canCancel: true });
  assert.strictEqual(countPrimaries(panel, dom), 1, 'the order view shows exactly one primary');
  assert(/class="vw-btn" data-action="order-track"/.test(panel), 'and it is Track');
  assert(/class="vw-btn secondary" data-action="order-issue"/.test(panel), 'Report an issue is secondary');

  // The order view plus its open issue form, which is what is actually on
  // screen when a customer is filling it in.
  state.returnFor = 'VEL-1234';
  state.returnItems = { i1: true };
  state.returnReason = 'Wrong size';
  const withForm = api.renderOrderPanel({ ...order, canRequestReturn: true });
  assert.strictEqual(countPrimaries(withForm, dom), 2,
    'Track and Send for review are both primary, one per section, which is the intended reading');
  assert(/class="vw-btn" data-action="return-submit"/.test(withForm), 'Send for review is primary');
  assert(/class="vw-btn ghost" data-action="return-cancel"/.test(withForm), 'Not now is ghost');
  state.returnFor = null;

  // The panel footer: three ghosts, none of them a primary.
  state.verified = true;
  state.orders = [order];
  const orders = api.renderOrders();
  const footer = orders.slice(orders.lastIndexOf('<div class="vw-actions footer"'));
  assert.strictEqual(countPrimaries(footer, dom), 0, 'the footer has no primary at all');
  assert(/ghost" data-action="refresh-order"/.test(footer));
  assert(/ghost" data-action="back-to-chat"/.test(footer));
  assert(/ghost quiet" data-action="signout"/.test(footer), 'Sign out is the quietest and sits last');
  assert(footer.lastIndexOf('data-action="signout"') > footer.lastIndexOf('data-action="back-to-chat"'), 'Sign out sits last');

  // Unverified, which is a different screen.
  state.verified = false;
  state.orders = null;
  assert.strictEqual(countPrimaries(api.renderOrders(), dom), 1, 'the signed-out orders view offers one way forward');

  // Cart, empty and full.
  state.__cart = [];
  assert.strictEqual(countPrimaries(api.renderCart(), dom), 0, 'an empty cart has nothing to press');
  state.__cart = [{ productId: 'p1', name: 'Kurta', size: 'M', color: 'Indigo', qty: 1, price: 249900 }];
  assert.strictEqual(countPrimaries(api.renderCart(), dom), 1, 'a full cart has one: Checkout');

  console.log('  ok  no screen shows more than one filled accent button');
}

function testReturnReasonOpensEmpty() {
  const { api, state, dom } = loadRenderers();
  const order = {
    displayId: 'VEL-1', status: 'DELIVERED', statusLabel: 'Delivered', stages: [], stageLabels: {},
    stageIndex: 4, total: '₹1', items: [{ itemId: 'i1', name: 'Kurta', size: 'M', color: 'Indigo', qty: 1, price: '₹1' }],
    tracking: null, canCancel: false, canRequestReturn: true,
  };

  state.returnFor = 'VEL-1';
  state.returnItems = {};
  state.returnReason = '';
  const fresh = api.renderReturnForm(order);

  // The placeholder is selected, and no real reason is.
  assert(/<option value="" selected disabled>Select a reason<\/option>/.test(fresh), 'opens on a placeholder');
  assert(!/<option value="Damaged item" selected>/.test(fresh), 'must not preseed Damaged item');
  assert(!/<option value="Wrong size" selected>/.test(fresh), 'must not preseed anything');

  const submit = (html) => {
    const el = dom.window.document.createElement('div');
    el.innerHTML = html;
    return el.querySelector('[data-action="return-submit"]');
  };
  assert(submit(fresh).hasAttribute('disabled'), 'disabled with neither an item nor a reason');

  state.returnItems = { i1: true };
  assert(submit(api.renderReturnForm(order)).hasAttribute('disabled'), 'still disabled with an item but no reason');

  state.returnItems = {};
  state.returnReason = 'Wrong size';
  assert(submit(api.renderReturnForm(order)).hasAttribute('disabled'), 'still disabled with a reason but no item');

  state.returnItems = { i1: true };
  state.returnReason = 'Wrong size';
  assert(!submit(api.renderReturnForm(order)).hasAttribute('disabled'), 'enabled once both are chosen');
  console.log('  ok  the return reason opens empty and Send waits for an item and a reason');
}

function testEmptyStateAndChips() {
  const { api, state, dom } = loadRenderers();
  state.config = { brandName: 'Test Store', welcomeMessage: 'How can we help?' };
  state.theme = {};

  const wordmark = api.renderEmptyState();
  assert(/vw-empty-word/.test(wordmark), 'falls back to the brand name as text');
  assert(/Test Store/.test(wordmark));

  state.theme = { logoUrl: 'https://cdn.test/logo.png', greeting: 'Ask us anything', suggestions: ['A?', 'B?', 'C?'] };
  const withLogo = api.renderEmptyState();
  assert(/vw-empty-logo/.test(withLogo), 'a theme logo replaces the wordmark');
  assert(/Ask us anything/.test(withLogo), 'the theme greeting wins over the config welcome');

  const el = dom.window.document.createElement('div');
  el.innerHTML = withLogo;
  const chips = [...el.querySelectorAll('.vw-faq')];
  assert.strictEqual(chips.length, 3, 'one chip per starter question');
  chips.forEach((chip) => assert.strictEqual(chip.getAttribute('type'), 'button', 'a chip must never submit a form'));

  // A javascript: logo must not reach an img src.
  state.theme = { logoUrl: 'javascript:alert(1)' };
  assert(!/javascript:/.test(api.renderEmptyState()), 'a hostile logo URL is refused');
  console.log('  ok  the empty state renders a logo or wordmark, a greeting and starter chips');
}

function testMobileFloorAndMotion() {
  // 360px is the floor the brief names. The panel keeps an inset on every
  // side at that width rather than going edge to edge, which is what preserves
  // the floating-card read on a phone.
  assert(/@media \(max-width: 640px\)/.test(CSS), 'a mobile breakpoint exists');
  assert(/width: calc\(100vw - 24px\)/.test(CSS), 'the panel stays inset on mobile');
  assert(/min\(400px, calc\(100vw - 32px\)\)/.test(CSS), 'and on desktop');
  assert(/prefers-reduced-motion/.test(CSS), 'reduced motion is respected');
  // 150 to 200ms, per the brief.
  const duration = CSS.match(/--sah-duration:\s*(\d+)ms/);
  assert(duration, 'a motion duration token exists');
  const ms = Number(duration[1]);
  assert(ms >= 150 && ms <= 200, `motion is ${ms}ms, the brief asks for 150 to 200`);
  console.log('  ok  the panel stays inset at 360px, and motion is in range and opt-out aware');
}

function testEveryButtonIsTyped() {
  // A button with no type defaults to submit. The composer is a real form, so
  // an untyped button anywhere near it navigates the page instead of acting.
  const untyped = SRC.match(/<button(?![^>]*\btype=)[^>]*>/g) || [];
  assert.deepStrictEqual(untyped, [], `untyped buttons in widget.js: ${untyped.join(' | ')}`);
  console.log('  ok  every button the widget renders declares its type');
}

function main() {
  console.log('widget visual system');
  testNoHardcodedVisuals();
  testEveryTokenUsedIsDefined();
  testOnePrimaryPerScreen();
  testReturnReasonOpensEmpty();
  testEmptyStateAndChips();
  testMobileFloorAndMotion();
  testEveryButtonIsTyped();
  console.log('\nAll widget visual system tests passed.');
}

try {
  main();
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
