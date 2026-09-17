/* ==========================================================================
   VELOUR frontend data layer.
   - Products, orders, payments, returns, and chat all go through the real
     backend under /api. Nothing about pricing, order status, or catalog
     data lives in the browser as the source of truth anymore.
   - The pre-purchase CART is still kept client side in localStorage, since
     there is no customer account system in this build and a cart has no
     integrity requirements before checkout, whatever is in it gets
     re-priced from the database the moment checkout is submitted.
   ========================================================================== */

const ICONS = {
  tee: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M35 8 L20 18 L8 34 L20 46 L30 38 L30 92 L70 92 L70 38 L80 46 L92 34 L80 18 L65 8 Q60 20 50 20 Q40 20 35 8 Z"/></svg>',
  hoodie: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M32 14 C32 6 68 6 68 14 L80 24 L92 40 L80 50 L70 42 L70 92 L30 92 L30 42 L20 50 L8 40 L20 24 Z"/><path d="M40 14 Q50 30 60 14"/><rect x="40" y="66" width="20" height="14" rx="3"/></svg>',
  jeans: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M25 6 H75 L80 92 L58 92 L54 40 L46 40 L42 92 L20 92 Z"/><path d="M25 6 L75 6" /></svg>',
  dress: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M40 6 L32 18 L20 94 L80 94 L68 18 L60 6 Q50 14 40 6 Z"/><path d="M38 6 Q50 2 62 6"/></svg>',
  jacket: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M34 10 L18 20 L6 38 L18 48 L28 40 L28 92 L50 92 L50 20 Z"/><path d="M66 10 L82 20 L94 38 L82 48 L72 40 L72 92 L50 92 L50 20 Z"/><path d="M40 10 Q50 22 60 10"/></svg>',
  joggers: '<svg viewBox="0 0 100 100" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"><path d="M27 6 H73 L76 60 L64 92 L56 92 L52 46 L48 46 L44 92 L36 92 L24 60 Z"/><path d="M27 6 L73 6"/></svg>',
};

function iconFor(key) { return ICONS[key] || ICONS.tee; }
function formatPaise(paise) { return '\u20B9' + (Number(paise) / 100).toLocaleString('en-IN'); }

let configPromise = null;
/** Fetches (once, cached) the same shipping thresholds and brand settings
 * the backend actually uses, so no page has to hardcode a number that
 * could quietly drift from what the backend really charges. */
function getConfig() {
  if (!configPromise) {
    configPromise = apiFetch('/api/config').catch(() => ({
      brandName: 'Store', brandAccent: '#6C5FFF', brandTagline: 'Your AI shopping assistant',
      shippingFreeThreshold: 199900, shippingFlatFee: 9900,
    }));
  }
  return configPromise;
}
function calculateShipping(subtotal, config) {
  if (subtotal <= 0) return 0;
  return subtotal >= config.shippingFreeThreshold ? 0 : config.shippingFlatFee;
}

async function apiFetch(path, options) {
  const res = await fetch((window.API_BASE || '') + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error((body && body.error) || 'Request failed');
    err.status = res.status;
    err.details = body && body.details;
    throw err;
  }
  return body;
}

const API = {
  getProducts: () => apiFetch('/api/products').then((d) => d.products),
  getConfig: () => getConfig(),
  checkout: (payload) => apiFetch('/api/orders/checkout', { method: 'POST', body: JSON.stringify(payload) }),
  verifyPayment: (payload) => apiFetch('/api/orders/verify-payment', { method: 'POST', body: JSON.stringify(payload) }),
  trackOrder: (payload) => apiFetch('/api/orders/track', { method: 'POST', body: JSON.stringify(payload) }),
  submitReturn: (payload) => apiFetch('/api/returns', { method: 'POST', body: JSON.stringify(payload) }),
  sendChat: (payload) => apiFetch('/api/chat', { method: 'POST', body: JSON.stringify(payload) }),
  uploadReturnPhoto: async (file) => {
    const form = new FormData();
    form.append('photo', file);
    const res = await fetch((window.API_BASE || '') + '/api/uploads/return-photo', {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || 'Upload failed');
    return body.url;
  },
};

/* ---------------------------- client side cart ---------------------------- */

const CART_KEY = 'velour_cart';

function readCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY) || '[]'); } catch (e) { return []; }
}
function writeCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  document.dispatchEvent(new CustomEvent('velour:cart-change'));
}

const Cart = {
  get: readCart,
  count: () => readCart().reduce((sum, l) => sum + l.qty, 0),
  subtotal: () => readCart().reduce((sum, l) => sum + l.qty * l.price, 0),
  add: (product, size, color, qty) => {
    const cart = readCart();
    const existing = cart.find((l) => l.productId === product.id && l.size === size && l.color === color);
    if (existing) existing.qty += qty;
    else cart.push({ productId: product.id, name: product.name, price: product.price, iconKey: product.iconKey, imageUrl: product.imageUrl, size, color, qty });
    writeCart(cart);
  },
  updateQty: (index, delta) => {
    const cart = readCart();
    if (!cart[index]) return;
    cart[index].qty += delta;
    if (cart[index].qty <= 0) cart.splice(index, 1);
    writeCart(cart);
  },
  remove: (index) => {
    const cart = readCart();
    cart.splice(index, 1);
    writeCart(cart);
  },
  clear: () => writeCart([]),
};

function refreshCartBadges() {
  const count = Cart.count();
  document.querySelectorAll('[data-nav-cart-badge], [data-vw-cart-badge]').forEach((el) => {
    el.textContent = count;
    el.hidden = count === 0;
  });
}
document.addEventListener('velour:cart-change', refreshCartBadges);
document.addEventListener('DOMContentLoaded', refreshCartBadges);

/** Escapes text before it is ever interpolated into an innerHTML string.
 * Every place in this app that renders user-typed or user-submitted text
 * (chat messages, names, addresses, return descriptions) must pass through
 * this first, this is the one function standing between free text input
 * and a stored or reflected XSS bug. */
function escapeHtml(str) {
  return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
