(function () {
  'use strict';

  if (window.__VELOUR_WIDGET_LOADED__) return;
  window.__VELOUR_WIDGET_LOADED__ = true;

  const script = document.currentScript;
  const API_BASE = ((script && script.getAttribute('data-api')) || window.VELOUR_WIDGET_API || window.API_BASE || '').replace(/\/$/, '');
  const ROOT_ID = 'velour-widget-root';
  /* The footer credit. Overridable per embed so a reseller can point it at
   * their own site without a rebuild. */
  const POWERED_BY_URL = (script && script.getAttribute('data-powered-by')) || window.VELOUR_POWERED_BY_URL || 'https://rizeandshine.in';
  const STYLE_ID = 'velour-widget-style';
  const state = {
    open: false,
    view: 'chat',
    sending: false,
    verified: false,
    verifying: false,
    codeSent: false,
    trackEmail: '',
    trackOrderId: '',
    messages: [],
    config: null,
    attachmentUrl: null,
    attachmentName: '',
    activeOrder: null,
    cartSubmitting: false,
    productChoice: {},
  };
  let host = null;
  let shadow = null;
  let container = null;
  /* Product cards are rendered from block data, so the click handler needs a
   * way back to the object behind the button it was given. Rebuilt from
   * scratch on every chat render, and the index is only ever read between
   * that render and the next one. */
  const productRefs = [];
  /* Per-card 'Added' timers, keyed by the same ref, so a second click
   * restarts the confirmation instead of letting an older timer cut it
   * short. */
  const addedTimers = {};
  let hasScrolled = false;

  const ESC = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  /* Only http and https URLs are ever written into an attribute. The API
   * and a database constraint reject anything else, this is the last check
   * before the value becomes markup. */
  const SAFE_URL = (value) => (typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '');
  const money = (value) => typeof window.formatPaise === 'function' ? window.formatPaise(value) : ('₹' + (Number(value || 0) / 100).toLocaleString('en-IN'));
  /* The cart stores paise, because renderCart and checkout both divide by
   * 100. search_catalog blocks carry pricePaise, suggest_add_ons blocks only
   * carry the formatted string, so that is parsed back when it is all there
   * is. */
  const pricePaise = (product) => {
    const exact = Number(product.pricePaise);
    if (Number.isFinite(exact)) return exact;
    const parsed = parseFloat(String(product.price == null ? '' : product.price).replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  };

  function sessionId() {
    let id = null;
    try { id = localStorage.getItem('velour_chat_session'); } catch (err) { /* The in-memory fallback avoids storing anything except the session id. */ }
    if (id) return id;
    id = window.crypto && crypto.randomUUID ? crypto.randomUUID() : 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2);
    try { localStorage.setItem('velour_chat_session', id); } catch (err) { /* Private browsing may block storage, so keep the id in memory for this page. */ }
    return id;
  }

  async function request(path, options = {}) {
    const headers = options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' };
    const response = await fetch(API_BASE + path, { credentials: 'include', ...options, headers: { ...headers, ...(options.headers || {}) } });
    let body = {};
    try { body = await response.json(); } catch (err) { /* Empty error bodies are handled below. */ }
    if (!response.ok) throw new Error(body.error || 'Request failed');
    return body;
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /* A single failed config request used to hide the widget permanently, so a
   * two second API blip looked to the client like their site was broken.
   * Three attempts with backoff covers a restart or a cold start. If they
   * all fail the widget still stays hidden rather than rendering someone
   * else's brand, but it says so in the console instead of vanishing
   * silently. */
  async function loadConfigWithRetry(attempts = 3) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await loadConfig();
      } catch (err) {
        if (attempt === attempts) throw err;
        await sleep(attempt * 600);
      }
    }
    return null;
  }

  async function loadConfig() {
    const data = await request('/api/config');
    state.config = data.brand ? { ...data.brand, brandName: data.brandName, brandTagline: data.brandTagline, welcomeMessage: data.welcomeMessage, suggestedQuestions: data.suggestedQuestions, shippingFreeThreshold: data.shippingFreeThreshold, shippingFlatFee: data.shippingFlatFee } : data;
    applyTokens();
  }

  function applyTokens() {
    const b = state.config || {};
    const root = shadow.host;
    const vars = {
      '--vw-accent': b.accent,
      '--vw-secondary': b.secondary,
      '--vw-background': b.background,
      '--vw-surface': b.surface,
      '--vw-text': b.textColor,
      '--vw-muted': b.mutedColor,
      '--vw-radius': `${b.borderRadius}px`,
      '--vw-font': b.fontFamily,
      '--vw-logo-height': `${b.logoHeight}px`,
    };
    Object.entries(vars).forEach(([key, value]) => { if (value != null) root.style.setProperty(key, value); });
    root.style.setProperty('--vw-position-right', b.widgetPosition === 'bottom-left' ? 'auto' : '20px');
    root.style.setProperty('--vw-position-left', b.widgetPosition === 'bottom-left' ? '20px' : 'auto');
  }

  function injectStylesheet() {
    if (shadow.querySelector('link[data-widget-style]')) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.widgetStyle = 'true';
    link.href = new URL('/css/widget.css', script && script.src ? script.src : window.location.href).href;
    shadow.appendChild(link);
  }

  function icon(name) {
    if (name === 'cart') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/></svg>';
    if (name === 'clip') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m21.4 11.6-8.8 8.8a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>';
    if (name === 'close') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8v.5z"/></svg>';
  }

  function logoHtml(dark = false, cls = 'vw-welcome-logo') {
    const b = state.config || {};
    const src = SAFE_URL(dark && b.logoDarkUrl ? b.logoDarkUrl : b.logoUrl);
    return src ? `<img class="${cls}" src="${ESC(src)}" alt="${ESC(b.brandName || '')}">` : '<div class="vw-welcome-empty" aria-hidden="true"></div>';
  }

  function shell() {
    const b = state.config || {};
    const showCart = b.showCart !== false;
    const showTrack = b.showTrackOrders !== false;
    const bubbleIcon = icon(b.bubbleIcon === 'cart' ? 'cart' : 'chat');
    container.innerHTML = `<div class="vw-panel" role="dialog" aria-label="${ESC(b.brandName || 'Shopping assistant')}">
      <header class="vw-header">
        ${b.logoDarkUrl || b.logoUrl ? logoHtml(true, 'vw-header-logo') : `<strong class="vw-header-name">${ESC(b.brandName || '')}</strong>`}
        ${showCart ? `<button class="vw-header-btn" data-action="cart" title="View cart" aria-label="View cart">${icon('cart')}</button>` : ''}
        ${showTrack ? `<button class="vw-header-btn" data-action="track">Track orders</button>` : ''}
        <button class="vw-header-btn" data-action="close" title="Close" aria-label="Close">${icon('close')}</button>
      </header>
      <main class="vw-body" data-body></main>
      <form class="vw-input" data-chat-form>
        <div class="vw-input-main"><input data-chat-input maxlength="1000" autocomplete="off" placeholder="Ask anything" ${state.sending ? 'disabled' : ''}><button type="button" class="vw-attach" data-action="attach" aria-label="Attach a photo">${icon('clip')}</button><input type="file" hidden accept="image/jpeg,image/png,image/webp" data-file></div>
        <button class="vw-send" type="submit" ${state.sending ? 'disabled' : ''} aria-label="Send">↑</button>
      </form>
      <div class="vw-footer">Powered by <a href="${ESC(SAFE_URL(POWERED_BY_URL))}" target="_blank" rel="noopener noreferrer">Sahaay</a></div>
    </div><button class="vw-bubble" data-action="toggle" aria-label="Open chat">${bubbleIcon}</button>`;
  }

  function render() {
    if (!shadow || !state.config) return;
    injectStylesheet();
    if (!container) {
      container = document.createElement('div');
      container.className = 'vw-root';
      shadow.appendChild(container);
    }
    shell();
    host.classList.toggle('open', state.open);
    const body = shadow.querySelector('[data-body]');
    if (state.view === 'chat') body.innerHTML = renderChat();
    if (state.view === 'track') body.innerHTML = renderTrack();
    if (state.view === 'cart') body.innerHTML = renderCart();
    if (state.view === 'checkout') body.innerHTML = renderCheckout();
    wire();
    scrollToLatest();
  }

  /* Jumps on the first paint, because there is nothing to animate from, and
   * eases on every render after it. */
  function scrollToLatest() {
    if (state.view !== 'chat') return;
    const body = shadow.querySelector('[data-body]');
    if (!body) return;
    const behavior = hasScrolled ? 'smooth' : 'auto';
    hasScrolled = true;
    try {
      body.scrollTo({ top: body.scrollHeight, behavior });
    } catch (err) {
      // Older engines reject the options form of scrollTo.
      body.scrollTop = body.scrollHeight;
    }
  }

  function renderChat() {
    const b = state.config;
    productRefs.length = 0;
    let html = `<section class="vw-welcome">${logoHtml(false)}<div class="vw-welcome-title">${ESC(b.brandName || '')}</div><div class="vw-welcome-copy">${ESC(b.welcomeMessage || b.brandTagline || '')}</div></section>`;
    if (!state.messages.length && (b.suggestedQuestions || []).length) {
      html += '<div class="vw-faqs">' + b.suggestedQuestions.map((q) => `<button class="vw-faq" data-question="${ESC(q)}">${ESC(q)}</button>`).join('') + '</div>';
    }
    // Quick replies hang off the first answer only. After that the
    // conversation has its own momentum and the chips are just clutter.
    const firstAnswer = state.messages.findIndex((m) => m.role !== 'user');
    html += state.messages.map((m, index) => {
      const bubble = `<div class="vw-msg ${m.role === 'user' ? 'user' : 'bot'}">${ESC(m.text)}</div>`;
      return bubble + renderBlocks(m.blocks || []) + (index === firstAnswer ? quickReplies() : '');
    }).join('');
    if (state.attachmentUrl) html += `<div class="vw-attachment">Attached: ${ESC(state.attachmentName || 'photo')}</div>`;
    if (state.sending) html += '<div class="vw-msg bot"><span class="vw-typing" role="status" aria-label="Assistant is typing"><span></span><span></span><span></span></span></div>';
    return html;
  }

  /* The same chips the welcome screen offers, shown once under the first
   * answer for a customer who is not sure what to ask next. Reuses the vw-faq
   * class and the data-question handler wire() already binds. */
  function quickReplies() {
    const questions = ((state.config || {}).suggestedQuestions || []).slice(0, 3);
    if (!questions.length) return '';
    return '<div class="vw-faqs vw-quick">' + questions.map((q) => `<button class="vw-faq" data-question="${ESC(q)}">${ESC(q)}</button>`).join('') + '</div>';
  }

  function renderBlocks(blocks) { return blocks.map(renderBlock).join(''); }
  function renderBlock(block) {
    if (!block || !block.type) return '';
    if (block.type === 'products') {
      const items = block.items || [];
      if (!items.length) return '';
      // How many products there are decides how they are shown: one gets the
      // room to be looked at, two get compared, more than two get listed.
      const mode = items.length === 1 ? 'hero' : (items.length === 2 ? 'compare' : 'rows');
      return `<section class="vw-card"><div class="vw-card-title">${ESC(block.heading || 'Recommended for you')}</div><div class="vw-products vw-products-${mode}">${items.map((item, index) => renderProduct(item, mode, index)).join('')}</div></section>`;
    }
    if (block.type === 'offers') return `<section class="vw-card"><div class="vw-card-title">Offers</div><div class="vw-offers">${(block.items || []).map((o) => `<div class="vw-offer"><strong>${ESC(o.title)}</strong>${o.code ? ` · ${ESC(o.code)}` : ''}<br>${ESC(o.description || '')}</div>`).join('')}</div></section>`;
    if (block.type === 'order') return renderOrder(block.order);
    if (block.type === 'verify') return renderVerify(block);
    if (block.type === 'proposal') return `<section class="vw-card vw-proposal"><div class="vw-card-title">Sent for review</div><div>Request <strong>${ESC(block.proposal?.displayId || '')}</strong> is pending human review.</div><div class="vw-empty">It is not approved yet. We will use the review decision to update you.</div></section>`;
    if (block.type === 'upload') return `<section class="vw-upload"><strong>Photo needed</strong><div class="vw-empty">Attach a clear JPEG, PNG, or WEBP photo using the paperclip beside the message field.</div><button type="button" class="vw-btn secondary" data-action="attach">Attach photo</button></section>`;
    return '';
  }

  /* What the customer has picked on a card, and what can be defaulted.
   *
   * A single option is not really a choice, so it is treated as already
   * chosen. That is what lets a one-size, one-colour product add on the first
   * tap while a product with real options waits for them. */
  function productOptions(p) {
    const sizes = Array.isArray(p.sizesInStock) ? p.sizesInStock : [];
    const colors = Array.isArray(p.colorsInStock) ? p.colorsInStock : [];
    const chosen = state.productChoice[p.id] || {};
    return {
      sizes,
      colors,
      size: chosen.size || (sizes.length === 1 ? sizes[0] : ''),
      color: chosen.color || (colors.length === 1 ? colors[0] : ''),
    };
  }

  /* The one gate between a product card and the cart.
   *
   * src/routes/orders.js resolves every posted line to a variant with the
   * composite key productId::size::color and fails the whole checkout when no
   * variant matches. A line missing either half of that key is therefore
   * unbuyable, and returning null here is what keeps it out of the cart
   * instead of surfacing as a checkout error several screens later. */
  function cartLineFor(product, size, color) {
    if (!product || !product.id || !size || !color) return null;
    return {
      productId: product.id,
      name: product.name,
      price: pricePaise(product),
      imageUrl: product.imageUrl,
      size,
      color,
      qty: 1,
    };
  }

  function addHintText(sizes, colors, size, color) {
    // No options at all means the block predates colorsInStock, or every
    // variant is gone. Either way there is nothing for the customer to pick.
    if (!sizes.length || !colors.length) return 'Options unavailable';
    if (!size) return 'Choose a size';
    if (!color) return 'Choose a colour';
    return '';
  }

  /* Tappable chips rather than a select: every option stays visible, and it
   * is one tap on a phone instead of a native picker sheet. */
  function chipRow(ref, kind, label, values, selected) {
    if (!values.length) return '';
    return `<div class="vw-chips" role="group" aria-label="${ESC(label)}"><span class="vw-chips-label">${ESC(label)}</span>${values.map((value) => `<button type="button" class="vw-chip${value === selected ? ' selected' : ''}" data-chip="${ref}" data-chip-kind="${ESC(kind)}" data-chip-value="${ESC(value)}" aria-pressed="${value === selected ? 'true' : 'false'}">${ESC(value)}</button>`).join('')}</div>`;
  }

  /* One card in one of three modes. The copy block is shared, the frame
   * around it is what changes. */
  function renderProduct(p, mode, index) {
    const ref = productRefs.push(p) - 1;
    const { sizes, colors, size, color } = productOptions(p);
    const soldOut = p.inStock === false;
    const image = SAFE_URL(p.imageUrl) ? `<img src="${ESC(SAFE_URL(p.imageUrl))}" alt="${ESC(p.name)}">` : '';

    let controls = '';
    if (soldOut) {
      // No Add button at all on a sold out card: a disabled one still invites
      // the tap that cannot work.
      controls = '<div class="vw-product-meta">Out of stock</div>';
    } else {
      const chips = chipRow(ref, 'size', 'Size', sizes, size)
        + (colors.length > 1 ? chipRow(ref, 'color', 'Colour', colors, color) : '')
        + (colors.length === 1 ? `<div class="vw-product-meta">Colour: ${ESC(colors[0])}</div>` : '');
      const ready = Boolean(cartLineFor(p, size, color));
      controls = `${chips}<div class="vw-product-hint">${ESC(addHintText(sizes, colors, size, color))}</div><button type="button" class="vw-btn vw-product-add" data-action="add-to-cart" data-product="${ref}"${ready ? '' : ' disabled'}>Add</button>`;
    }

    const copy = `<div class="vw-product-copy"><div class="vw-product-name">${ESC(p.name)}</div><div class="vw-product-price">${ESC(p.price || '')}</div>${p.fabric ? `<div class="vw-product-meta">${ESC(p.fabric)}</div>` : ''}${controls}</div>`;

    // The first of a pair is the one the agent put first, which is the one it
    // is recommending.
    const recommended = mode === 'compare' && index === 0;
    const classes = ['vw-product', `vw-product-${mode}`];
    if (recommended) classes.push('vw-product-recommended');
    if (soldOut) classes.push('vw-product-soldout');

    return `<article class="${classes.join(' ')}">${recommended ? '<div class="vw-product-badge">Recommended</div>' : ''}${image}${copy}</article>`;
  }

  /* Chip taps and Add both update the DOM in place. render() rebuilds the
   * whole panel including the message field, so re-rendering here would drop
   * anything the customer had half typed. */
  function selectChip(el) {
    const ref = el.getAttribute('data-chip');
    const product = productRefs[Number(ref)];
    if (!product) return;
    const kind = el.getAttribute('data-chip-kind');
    const choice = state.productChoice[product.id] || (state.productChoice[product.id] = {});
    choice[kind] = el.getAttribute('data-chip-value');

    el.parentNode.querySelectorAll('.vw-chip').forEach((chip) => {
      const on = chip === el;
      chip.classList.toggle('selected', on);
      chip.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    syncAddButton(ref);
  }

  function syncAddButton(ref) {
    const product = productRefs[Number(ref)];
    const button = shadow.querySelector(`[data-action="add-to-cart"][data-product="${ref}"]`);
    if (!product || !button) return;
    const { sizes, colors, size, color } = productOptions(product);
    button.disabled = !cartLineFor(product, size, color);
    const hint = button.parentNode.querySelector('.vw-product-hint');
    if (hint) hint.textContent = addHintText(sizes, colors, size, color);
  }

  function addProductToCart(ref) {
    const product = productRefs[Number(ref)];
    if (!product) return;
    if (!window.Cart || typeof window.Cart.add !== 'function') {
      state.messages.push({ role: 'assistant', text: 'The cart is only available on the storefront right now.' });
      render();
      return;
    }

    const { size, color } = productOptions(product);
    const line = cartLineFor(product, size, color);
    // The button is already disabled in this state; this is the second lock on
    // the same door, because an unbuyable line fails at checkout, not here.
    if (!line) return;

    window.Cart.add(
      { id: line.productId, name: line.name, price: line.price, imageUrl: line.imageUrl },
      line.size,
      line.color,
      line.qty
    );
    flashAdded(ref);
  }

  function flashAdded(ref) {
    const button = shadow.querySelector(`[data-action="add-to-cart"][data-product="${ref}"]`);
    if (!button) return;
    if (addedTimers[ref]) clearTimeout(addedTimers[ref]);
    button.textContent = 'Added';
    button.classList.add('added');
    addedTimers[ref] = setTimeout(() => {
      delete addedTimers[ref];
      const live = shadow.querySelector(`[data-action="add-to-cart"][data-product="${ref}"]`);
      if (!live) return;
      live.textContent = 'Add';
      live.classList.remove('added');
    }, 1600);
  }

  function renderOrder(order) {
    if (!order) return '';
    return `<section class="vw-card"><div class="vw-card-title">Order ${ESC(order.displayId)}</div><div class="vw-status">${ESC(order.status)}</div>${(order.items || []).map((i) => `<div class="vw-order-item"><span>${ESC(i.name)} · ${ESC(i.size)} · ${ESC(i.color)} × ${ESC(i.qty)}</span><span>${ESC(i.price)}</span></div>`).join('')}${order.tracking ? `<div class="vw-order-tracking">Tracking: ${ESC(order.tracking.carrier || '')} ${ESC(order.tracking.number || '')}${SAFE_URL(order.tracking.url) ? ` · <a class="vw-link" href="${ESC(SAFE_URL(order.tracking.url))}" target="_blank" rel="noopener">Open tracking</a>` : ''}</div>` : '<div class="vw-empty vw-order-tracking">Tracking is not available yet.</div>'}</section>`;
  }

  function renderVerify(block) {
    const message = state.verifying ? 'Checking code...' : `Enter the six digit code sent to ${ESC(block.email || state.trackEmail)}.`;
    return `<section class="vw-card"><div class="vw-card-title">Verify your order</div><div class="vw-empty">${message}</div><div class="vw-field vw-code-field"><input class="vw-code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" data-verify-code placeholder="000000"></div><button type="button" class="vw-btn" data-action="verify-code" ${state.verifying ? 'disabled' : ''}>Verify</button><div class="vw-empty" data-verify-msg></div></section>`;
  }

  function renderTrack() {
    if (state.verified) return `<section class="vw-card"><div class="vw-card-title">Signed in</div><div class="vw-empty">Orders are linked to this session.</div><div class="vw-actions"><button class="vw-btn" data-action="refresh-order">Show order status</button><button class="vw-btn secondary" data-action="signout">Sign out</button></div></section>`;
    return `<section class="vw-card"><div class="vw-card-title">Track orders</div><div class="vw-field"><label>Email used at checkout</label><input type="email" data-track-email value="${ESC(state.trackEmail)}"></div><div class="vw-field"><label>Order ID</label><input data-track-order value="${ESC(state.trackOrderId)}" placeholder="VEL-XXXXXX"></div>${state.codeSent ? `<div class="vw-field"><label>Six digit code</label><input class="vw-code" data-track-code maxlength="6" inputmode="numeric"></div><div class="vw-actions"><button class="vw-btn" data-action="track-verify">Verify code</button></div>` : `<button class="vw-btn" data-action="request-code">Email me a code</button>`}<div class="vw-empty" data-track-msg></div></section>`;
  }

  function cartLines() {
    return window.Cart && typeof window.Cart.get === 'function' ? window.Cart.get() : [];
  }

  function renderCart() {
    const cart = cartLines();
    return `<section class="vw-card"><div class="vw-card-title">Your cart</div>${cart.length ? cart.map((line) => `<div class="vw-cart-line">${SAFE_URL(line.imageUrl) ? `<img src="${ESC(SAFE_URL(line.imageUrl))}" alt="">` : ''}<div class="vw-cart-info"><div class="vw-cart-name">${ESC(line.name)}</div><div class="vw-cart-meta">${ESC(line.size)}, ${ESC(line.color)} × ${ESC(line.qty)}</div></div><strong>${ESC(money(line.price * line.qty))}</strong></div>`).join('') + `<div class="vw-actions"><button class="vw-btn" data-action="checkout">Checkout</button></div>` : '<div class="vw-empty">Your cart is empty. Add something from the storefront.</div>'}</section>`;
  }

  function renderCheckout() {
    if (!cartLines().length) return '<section class="vw-card"><div class="vw-card-title">Checkout</div><div class="vw-empty">Your cart is empty.</div></section>';
    return `<section class="vw-card"><div class="vw-card-title">Secure checkout</div><form data-checkout-form><div class="vw-field"><label>Full name</label><input name="name" required></div><div class="vw-field"><label>Email</label><input name="email" type="email" required></div><div class="vw-field"><label>Phone</label><input name="phone" required></div><div class="vw-field"><label>Address</label><input name="address" required></div><div class="vw-field"><label>City</label><input name="city" required></div><div class="vw-field"><label>State</label><input name="state" required></div><div class="vw-field"><label>PIN code</label><input name="pincode" required></div><div class="vw-field"><label>Offer code (optional)</label><input name="offerCode" autocomplete="off"></div><button class="vw-btn" ${state.cartSubmitting ? 'disabled' : ''}>Pay securely</button><div class="vw-empty" data-checkout-msg></div></form></section>`;
  }

  async function sendChat(text, attachmentUrl = null) {
    state.messages.push({ role: 'user', text: text || (attachmentUrl ? 'I attached a photo.' : '') });
    state.sending = true;
    state.attachmentUrl = null;
    state.attachmentName = '';
    render();
    try {
      const data = await request('/api/chat', { method: 'POST', body: JSON.stringify({ sessionId: sessionId(), message: text || '', attachmentUrl: attachmentUrl || undefined }) });
      state.verified = Boolean(data.verified);
      state.messages.push({ role: 'assistant', text: data.reply || 'I could not answer that right now.', blocks: data.blocks || [] });
    } catch (err) {
      state.messages.push({ role: 'assistant', text: err.message || 'I am having trouble reaching the assistant right now.' });
    } finally {
      state.sending = false;
      render();
    }
  }

  async function uploadPhoto(file) {
    const form = new FormData();
    form.append('photo', file);
    const data = await request('/api/uploads/return-photo', { method: 'POST', body: form });
    state.attachmentUrl = data.url;
    state.attachmentName = file.name;
    render();
  }

  async function requestCode() {
    const email = shadow.querySelector('[data-track-email]').value.trim();
    const displayId = shadow.querySelector('[data-track-order]').value.trim();
    const msg = shadow.querySelector('[data-track-msg]');
    state.trackEmail = email; state.trackOrderId = displayId;
    if (!email || !displayId) { msg.textContent = 'Enter both fields first.'; return; }
    try {
      await request('/api/session/request-code', { method: 'POST', body: JSON.stringify({ sessionId: sessionId(), email, displayId }) });
      state.codeSent = true; render();
    } catch (err) { msg.textContent = err.message; }
  }

  // Verification is intentionally posted to /api/session/verify, never to
  // /api/chat. This prevents an authentication credential from reaching the
  // model context and blocks prompt injection from crossing the trust boundary.
  async function verifyDirect(code, messageEl) {
    state.verifying = true;
    try {
      const data = await request('/api/session/verify', { method: 'POST', body: JSON.stringify({ sessionId: sessionId(), code }) });
      state.verified = true; state.verifying = false; state.codeSent = false;
      render();
      state.messages.push({ role: 'assistant', text: `Verified for order ${data.orderDisplayId}.` });
      render();
    } catch (err) {
      state.verifying = false;
      if (messageEl) messageEl.textContent = err.message;
      else render();
    }
  }

  async function refreshState() {
    try {
      const data = await request('/api/session/state', { method: 'POST', body: JSON.stringify({ sessionId: sessionId() }) });
      state.verified = Boolean(data.verified);
    } catch (err) { state.verified = false; }
  }

  async function showOrderStatus() {
    state.view = 'chat';
    await sendChat('Show me my order status');
  }

  async function signout() {
    await request('/api/session/signout', { method: 'POST', body: JSON.stringify({}) });
    state.verified = false; state.activeOrder = null; state.codeSent = false; state.messages = [];
    render();
  }

  function loadRazorpay() {
    if (window.Razorpay) return Promise.resolve();
    if (window.__velourRazorpayPromise) return window.__velourRazorpayPromise;
    window.__velourRazorpayPromise = new Promise((resolve, reject) => {
      const checkoutScript = document.createElement('script');
      checkoutScript.src = 'https://checkout.razorpay.com/v1/checkout.js';
      checkoutScript.async = true;
      checkoutScript.onload = resolve;
      checkoutScript.onerror = () => reject(new Error('Payment provider could not be loaded.'));
      document.head.appendChild(checkoutScript);
    });
    return window.__velourRazorpayPromise;
  }

  async function openRazorpay(order, customer) {
    await loadRazorpay();
    return new Promise((resolve) => {
      const rzp = new window.Razorpay({
        key: order.razorpayKeyId,
        amount: order.total,
        currency: 'INR',
        name: state.config.brandName || 'Store',
        description: 'Order ' + order.displayId,
        order_id: order.razorpayOrderId,
        prefill: { name: customer.name, email: customer.email, contact: customer.phone },
        notes: { displayId: order.displayId },
        modal: { ondismiss: () => { state.cartSubmitting = false; render(); resolve(); } },
        handler: async (response) => {
          try {
            await request('/api/orders/verify-payment', {
              method: 'POST',
              body: JSON.stringify({
                orderId: order.orderId,
                razorpayOrderId: response.razorpay_order_id,
                razorpayPaymentId: response.razorpay_payment_id,
                razorpaySignature: response.razorpay_signature,
              }),
            });
            if (window.Cart && typeof window.Cart.clear === 'function') window.Cart.clear();
            state.cartSubmitting = false;
            state.view = 'chat';
            state.messages.push({ role: 'assistant', text: `Payment received. Your order ${order.displayId} is confirmed.` });
            render();
          } catch (err) {
            state.cartSubmitting = false;
            state.view = 'chat';
            state.messages.push({ role: 'assistant', text: 'Payment may have succeeded, but the browser could not confirm it. Keep order ' + order.displayId + ' for tracking.' });
            render();
          }
          resolve();
        },
      });
      rzp.open();
    });
  }

  function wire() {
    shadow.querySelectorAll('[data-action="toggle"]').forEach((el) => el.addEventListener('click', () => { state.open = true; render(); }));
    shadow.querySelectorAll('[data-action="close"]').forEach((el) => el.addEventListener('click', () => { state.open = false; render(); }));
    shadow.querySelector('[data-chat-form]').addEventListener('submit', (event) => {
      event.preventDefault();
      const input = shadow.querySelector('[data-chat-input]');
      const text = input.value.trim();
      if ((!text && !state.attachmentUrl) || state.sending) return;
      input.value = '';
      sendChat(text, state.attachmentUrl);
    });
    shadow.querySelectorAll('[data-action="attach"]').forEach((el) => el.addEventListener('click', () => shadow.querySelector('[data-file]').click()));
    shadow.querySelector('[data-file]').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0]; if (!file) return;
      try { await uploadPhoto(file); } catch (err) { state.messages.push({ role: 'assistant', text: err.message || 'Could not attach that photo.' }); render(); }
    });
    shadow.querySelectorAll('[data-question]').forEach((el) => el.addEventListener('click', () => sendChat(el.getAttribute('data-question'))));
    shadow.querySelectorAll('[data-action="add-to-cart"]').forEach((el) => el.addEventListener('click', () => addProductToCart(el.getAttribute('data-product'))));
    shadow.querySelectorAll('[data-chip]').forEach((el) => el.addEventListener('click', () => selectChip(el)));
    shadow.querySelector('[data-action="cart"]')?.addEventListener('click', () => { state.view = 'cart'; render(); });
    shadow.querySelector('[data-action="track"]')?.addEventListener('click', () => { state.view = 'track'; render(); });
    shadow.querySelector('[data-action="request-code"]')?.addEventListener('click', requestCode);
    shadow.querySelector('[data-action="track-verify"]')?.addEventListener('click', () => verifyDirect(shadow.querySelector('[data-track-code]').value.trim(), shadow.querySelector('[data-track-msg]')));
    shadow.querySelector('[data-action="signout"]')?.addEventListener('click', signout);
    shadow.querySelector('[data-action="refresh-order"]')?.addEventListener('click', showOrderStatus);
    shadow.querySelector('[data-action="checkout"]')?.addEventListener('click', () => { state.view = 'checkout'; render(); });
    shadow.querySelector('[data-action="verify-code"]')?.addEventListener('click', () => {
      const code = shadow.querySelector('[data-verify-code]').value.trim();
      verifyDirect(code, shadow.querySelector('[data-verify-msg]'));
    });
    shadow.querySelector('[data-checkout-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!window.API || typeof window.API.checkout !== 'function') {
        shadow.querySelector('[data-checkout-msg]').textContent = 'Checkout is available on the storefront widget.'; return;
      }
      state.cartSubmitting = true; render();
      try {
        const values = Object.fromEntries(new FormData(shadow.querySelector('[data-checkout-form]')).entries());
        const cart = cartLines();
        // Only the code travels. The discount is recomputed server side from
        // the offers table, so nothing typed here can change the amount
        // charged.
        const offerCode = (values.offerCode || '').trim();
        delete values.offerCode;
        const order = await window.API.checkout({ idempotencyKey: crypto.randomUUID(), items: cart.map((l) => ({ productId: l.productId, size: l.size, color: l.color, qty: l.qty })), customer: values, offerCode: offerCode || undefined });
        await openRazorpay(order, values);
      } catch (err) {
        state.cartSubmitting = false; render();
        const msg = shadow.querySelector('[data-checkout-msg]'); if (msg) msg.textContent = err.message;
      }
    });
  }

  async function init() {
    host = document.getElementById(ROOT_ID) || document.createElement('div');
    host.id = ROOT_ID;
    if (!document.getElementById(ROOT_ID)) document.body.appendChild(host);
    shadow = host.shadowRoot || host.attachShadow({ mode: 'open' });
    await refreshState();
    try { await loadConfigWithRetry(); } catch (err) {
      // No fabricated brand styling: the widget stays hidden rather than
      // silently rendering a name or colour belonging to another deployment.
      // Logged loudly so this is diagnosable instead of looking like the
      // script never loaded.
      console.error('Velour widget: /api/config unreachable after 3 attempts, widget not shown.', err);
      host.innerHTML = '';
      return;
    }
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
