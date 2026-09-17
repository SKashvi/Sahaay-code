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

  /* Layer 4 of the theme resolution order, and the only one the server cannot
   * see: attributes on this script tag. Read once, here, because
   * document.currentScript is only meaningful while the script is executing.
   *
   * Names mirror the SAHAAY_* environment variables, so a value can be moved
   * between an env var, the dashboard and the embed tag without renaming it:
   *   <script src="widget.js" data-accent="#0E7C66" data-density="compact">
   */
  const SCRIPT_THEME = (() => {
    if (!script) return {};
    const attr = (name) => {
      const value = script.getAttribute(`data-${name}`);
      return value && value.trim() ? value.trim() : null;
    };
    return {
      accent: attr('accent'),
      accentInk: attr('accent-ink'),
      bg: attr('bg'),
      tintFrom: attr('tint-from'),
      tintTo: attr('tint-to'),
      ink: attr('ink'),
      radiusShell: attr('radius-shell'),
      radiusCard: attr('radius-card'),
      font: attr('font'),
      headerStyle: attr('header-style'),
      density: attr('density'),
      logoUrl: attr('logo-url'),
      greeting: attr('greeting'),
    };
  })();

  /* The same validation lib/theme.js applies server side. Repeated rather than
   * shared because these values become CSS custom properties in this document,
   * and the layer they come from (a script tag on someone else's page) is the
   * one the server never got to check. */
  const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
  const okColor = (v) => (typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : null);
  const okPx = (v, max) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null;
  };
  const okFont = (v) => (typeof v === 'string' && !/url\s*\(|@import|[;{}]/i.test(v) && /^[\w\s,'"().-]{1,200}$/.test(v.trim()) ? v.trim() : null);
  const okEnum = (v, allowed) => (typeof v === 'string' && allowed.indexOf(v.trim()) > -1 ? v.trim() : null);
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
    theme: {},
    /* The verified customer's orders, read straight from the orders API. Not
     * a chat message and not a model output: the panel is the primary path for
     * anything about an order, and the chat input is for open questions. */
    orders: null,
    verifiedEmail: '',
    ordersLoading: false,
    ordersError: '',
    ordersNotice: '',
    // Which order's return form is open, and what is selected in it.
    returnFor: null,
    // Empty, deliberately. A preselected reason is a reason the customer did
    // not give, attached to a request a person will act on.
    returnReason: '',
    returnItems: {},
    returnSubmitting: false,
    returnError: '',
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

  /* Chat history, per session id, in sessionStorage.
   *
   * The session id already survives a page change (localStorage), but the
   * rendered messages did not, so walking from the shop to the cart wiped the
   * conversation on screen while the server still had it.
   *
   * sessionStorage rather than a server read: the session id comes from the
   * browser and is explicitly NOT proof of identity anywhere in this codebase
   * (see src/middleware/customerAuth.js). There is no endpoint that returns a
   * transcript by session id, and adding one would mean any script that can
   * read localStorage could also read back a conversation that may name an
   * order. The transcript is already in the browser that produced it, so it
   * is kept there, in the tab that owns it.
   */
  const HISTORY_LIMIT = 20;
  const historyKey = () => `velour_chat_log_${sessionId()}`;

  function loadHistory() {
    try {
      const raw = sessionStorage.getItem(historyKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      // Shaped on the way in, because this is browser storage and anything
      // could have written to it.
      return parsed
        .filter((m) => m && typeof m.text === 'string')
        .slice(-HISTORY_LIMIT)
        .map((m) => ({
          role: m.role === 'user' ? 'user' : 'assistant',
          text: m.text,
          blocks: Array.isArray(m.blocks) ? m.blocks : [],
        }));
    } catch (err) {
      return [];
    }
  }

  function saveHistory() {
    try {
      sessionStorage.setItem(historyKey(), JSON.stringify(state.messages.slice(-HISTORY_LIMIT)));
    } catch (err) {
      // Private browsing, or a full quota. The conversation still works for
      // this page, it just will not survive the next one.
    }
  }

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
    // The widget endpoint returns everything /api/config does, plus the theme,
    // so this is one request rather than two.
    const data = await request('/api/widget/config');
    state.config = data.brand ? { ...data.brand, brandName: data.brandName, brandTagline: data.brandTagline, welcomeMessage: data.welcomeMessage, suggestedQuestions: data.suggestedQuestions, shippingFreeThreshold: data.shippingFreeThreshold, shippingFlatFee: data.shippingFlatFee } : data;
    // Layers 1 to 3, already resolved and validated server side.
    state.theme = data.theme || {};
    applyTokens();
    applyTheme();
  }

  /* Layer 4 over the server's answer, then onto the host element as custom
   * properties. Set on shadow.host rather than inside the shadow root so the
   * bubble, which lives outside the panel, inherits them too.
   *
   * Called before the first render, so the panel's first paint already has its
   * colours. This is the same failure the storefront's brand-flash fix
   * addressed: a value that lands after the first paint is a value the
   * customer watches change. */
  function applyTheme() {
    if (!shadow) return;
    const t = { ...(state.theme || {}) };

    // Layer 4 wins where it is present and valid.
    if (okColor(SCRIPT_THEME.accent)) t.accent = okColor(SCRIPT_THEME.accent);
    if (okColor(SCRIPT_THEME.accentInk)) t.accentInk = okColor(SCRIPT_THEME.accentInk);
    if (okColor(SCRIPT_THEME.bg)) t.bg = okColor(SCRIPT_THEME.bg);
    if (okColor(SCRIPT_THEME.tintFrom)) t.tintFrom = okColor(SCRIPT_THEME.tintFrom);
    if (okColor(SCRIPT_THEME.tintTo)) t.tintTo = okColor(SCRIPT_THEME.tintTo);
    if (okColor(SCRIPT_THEME.ink)) t.ink = okColor(SCRIPT_THEME.ink);
    if (okPx(SCRIPT_THEME.radiusShell, 64) !== null) t.radiusShell = okPx(SCRIPT_THEME.radiusShell, 64);
    if (okPx(SCRIPT_THEME.radiusCard, 48) !== null) t.radiusCard = okPx(SCRIPT_THEME.radiusCard, 48);
    if (okFont(SCRIPT_THEME.font)) t.font = okFont(SCRIPT_THEME.font);
    if (okEnum(SCRIPT_THEME.headerStyle, ['floating', 'solid'])) t.headerStyle = SCRIPT_THEME.headerStyle;
    if (okEnum(SCRIPT_THEME.density, ['comfortable', 'compact'])) t.density = SCRIPT_THEME.density;
    if (SCRIPT_THEME.logoUrl && SAFE_URL(SCRIPT_THEME.logoUrl)) t.logoUrl = SCRIPT_THEME.logoUrl;
    if (SCRIPT_THEME.greeting) t.greeting = String(SCRIPT_THEME.greeting).slice(0, 200);

    state.theme = t;
    injectThemeStyle();
    const host = shadow.host;
    const set = (name, value) => { if (value != null && value !== '') host.style.setProperty(name, value); };

    set('--sah-accent', t.accent);
    set('--sah-accent-ink', t.accentInk);
    set('--sah-bg', t.bg);
    set('--sah-bg-tint-from', t.tintFrom);
    set('--sah-bg-tint-to', t.tintTo);
    set('--sah-ink', t.ink);
    set('--sah-font', t.font);
    if (t.radiusShell != null) set('--sah-radius-shell', `${t.radiusShell}px`);
    if (t.radiusCard != null) set('--sah-radius-card', `${t.radiusCard}px`);
    // Derived from the tokens above rather than stored separately, so one
    // accent restyles the widget and there is no second palette to keep up.
    if (t.accent) set('--sah-accent-soft', `color-mix(in srgb, ${t.accent} 8%, transparent)`);
    if (t.ink && t.bg) {
      set('--sah-ink-muted', `color-mix(in srgb, ${t.ink} 58%, ${t.bg})`);
      set('--sah-ink-faint', `color-mix(in srgb, ${t.ink} 32%, ${t.bg})`);
      set('--sah-line', `color-mix(in srgb, ${t.ink} 10%, ${t.bg})`);
    }
    // Structural choices ride as attributes so CSS can branch on them without
    // a second class list to keep in sync.
    host.setAttribute('data-sah-header', t.headerStyle || 'floating');
    host.setAttribute('data-sah-density', t.density || 'comfortable');
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

  /* No unstyled frame.
   *
   * The layout comes from an external stylesheet, which loads asynchronously,
   * so markup appended before it arrives would paint once with no styles and
   * again with them. Two things prevent that:
   *
   *   1. The resolved theme is written into an inline <style> synchronously,
   *      so the custom properties exist from the very first paint rather than
   *      arriving with the sheet.
   *   2. The root stays hidden until the sheet has actually loaded. visibility
   *      rather than display, so the panel's size is already settled and
   *      nothing reflows when it appears. A failed sheet still reveals, on the
   *      load-or-error handler, because a permanently invisible widget is a
   *      worse outcome than an ugly one.
   */
  function injectStylesheet() {
    if (shadow.querySelector('link[data-widget-style]')) return;

    const gate = document.createElement('style');
    gate.dataset.widgetGate = 'true';
    gate.textContent = '.vw-root{visibility:hidden}';
    shadow.appendChild(gate);

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.dataset.widgetStyle = 'true';
    link.href = new URL('/css/widget.css', script && script.src ? script.src : window.location.href).href;
    const reveal = () => { gate.textContent = ''; };
    link.addEventListener('load', reveal, { once: true });
    link.addEventListener('error', reveal, { once: true });
    // A sheet already in the browser cache can finish before the listener is
    // attached, which would leave the widget hidden forever.
    setTimeout(reveal, 2000);
    shadow.appendChild(link);
  }

  /* The resolved theme as a real stylesheet inside the shadow root.
   *
   * applyTheme() sets the same properties on the host element, which is what
   * makes them inherit to the bubble outside the panel. This inline copy is
   * what makes them present in the very first paint, before the external sheet
   * has loaded, so the widget never renders in the default palette first. */
  function injectThemeStyle() {
    if (!shadow) return;
    const t = state.theme || {};
    const declarations = [
      t.accent ? `--sah-accent:${t.accent}` : '',
      t.accentInk ? `--sah-accent-ink:${t.accentInk}` : '',
      t.accent ? `--sah-accent-soft:color-mix(in srgb, ${t.accent} 8%, transparent)` : '',
      t.bg ? `--sah-bg:${t.bg}` : '',
      t.tintFrom ? `--sah-bg-tint-from:${t.tintFrom}` : '',
      t.tintTo ? `--sah-bg-tint-to:${t.tintTo}` : '',
      t.ink ? `--sah-ink:${t.ink}` : '',
      t.ink && t.bg ? `--sah-ink-muted:color-mix(in srgb, ${t.ink} 58%, ${t.bg})` : '',
      t.ink && t.bg ? `--sah-ink-faint:color-mix(in srgb, ${t.ink} 32%, ${t.bg})` : '',
      t.ink && t.bg ? `--sah-line:color-mix(in srgb, ${t.ink} 10%, ${t.bg})` : '',
      t.radiusShell != null ? `--sah-radius-shell:${t.radiusShell}px` : '',
      t.radiusCard != null ? `--sah-radius-card:${t.radiusCard}px` : '',
      t.font ? `--sah-font:${t.font}` : '',
    ].filter(Boolean).join(';');
    if (!declarations) return;

    let el = shadow.querySelector('style[data-widget-theme]');
    if (!el) {
      el = document.createElement('style');
      el.dataset.widgetTheme = 'true';
      // Ahead of the external sheet so the sheet's own :host defaults do not
      // win on specificity, and present before anything paints.
      shadow.insertBefore(el, shadow.firstChild);
    }
    // Every value here came through the validators above or the server's, so
    // none of them can carry a semicolon out of its declaration.
    el.textContent = `:host{${declarations}}`;
  }

  function icon(name) {
    if (name === 'cart-plus') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="9" cy="20" r="1.4"/><circle cx="18" cy="20" r="1.4"/><path d="M2 3h2.2l2.3 11.2a1.7 1.7 0 0 0 1.7 1.3h8.6a1.7 1.7 0 0 0 1.7-1.3l.9-4.2"/><path d="M16 2.5v6M13 5.5h6"/></svg>';
    if (name === 'chevron-left') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
    if (name === 'chevron-right') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>';
    if (name === 'chevron-down') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
    if (name === 'send') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
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
    const count = cartCount();
    // A subview is anything other than the conversation, so the back chevron
    // appears exactly when there is somewhere to go back to.
    const inSubview = state.view !== 'chat';
    const started = state.messages.length > 0;

    container.innerHTML = `<div class="vw-panel" role="dialog" aria-label="${ESC(b.brandName || 'Shopping assistant')}">
      <header class="vw-header">
        ${inSubview ? `<button type="button" class="vw-pill vw-pill-icon" data-action="back" title="Back" aria-label="Back">${icon('chevron-left')}</button>` : ''}
        <span class="vw-header-spacer"></span>
        ${showCart ? `<span class="vw-pill-wrap"><button type="button" class="vw-pill vw-pill-icon" data-action="cart" title="View cart" aria-label="View cart">${icon('cart')}</button><span class="vw-badge" data-cart-badge ${count ? '' : 'hidden'}>${ESC(count)}</span></span>` : ''}
        ${showTrack ? `<button type="button" class="vw-pill" data-action="track">Track orders</button>` : ''}
        <button type="button" class="vw-pill vw-pill-icon" data-action="close" title="Close" aria-label="Close">${icon('close')}</button>
      </header>
      <main class="vw-body" data-body></main>
      <button type="button" class="vw-scroll-end" data-action="scroll-end" aria-label="Scroll to newest" hidden>${icon('chevron-down')}</button>
      <form class="vw-input" data-chat-form>
        <div class="vw-input-main">
          <input data-chat-input maxlength="1000" autocomplete="off" placeholder="${started ? 'Reply' : 'Ask anything'}" ${state.sending ? 'disabled' : ''}>
          <button type="button" class="vw-attach" data-action="attach" aria-label="Attach a photo">${icon('clip')}</button>
          <input type="file" hidden accept="image/jpeg,image/png,image/webp" data-file>
        </div>
        <button class="vw-send" type="submit" data-send ${state.sending ? 'disabled' : ''} aria-label="Send" hidden>${icon('send')}</button>
      </form>
      <div class="vw-footer">Powered by <a href="${ESC(SAFE_URL(POWERED_BY_URL))}" target="_blank" rel="noopener noreferrer">Sahaay</a></div>
    </div><button type="button" class="vw-bubble" data-action="toggle" aria-label="Open chat">${bubbleIcon}</button>`;
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
    if (state.view === 'orders') body.innerHTML = renderOrders();
    wire();
    refreshBadge();
    syncComposer();
    scrollToLatest();
    syncScrollButton();
  }

  /* The cart count, updated in place. A full render would rebuild the panel
   * and drop whatever was half typed in the composer, so the badge is touched
   * directly and this can be called from a cart event at any moment. */
  function refreshBadge() {
    if (!shadow) return;
    const badge = shadow.querySelector('[data-cart-badge]');
    if (!badge) return;
    const count = cartCount();
    badge.textContent = String(count);
    badge.hidden = count === 0;
  }

  /* The send button only exists once there is something to send, and the
   * scroll-to-bottom button only once the view is actually scrolled up. Both
   * are direct DOM for the same reason as the badge. */
  function syncComposer() {
    if (!shadow) return;
    const input = shadow.querySelector('[data-chat-input]');
    const send = shadow.querySelector('[data-send]');
    if (!input || !send) return;
    const hasContent = Boolean(input.value.trim()) || Boolean(state.attachmentUrl);
    send.hidden = !hasContent;
  }

  function syncScrollButton() {
    if (!shadow) return;
    const body = shadow.querySelector('[data-body]');
    const button = shadow.querySelector('[data-action="scroll-end"]');
    if (!body || !button) return;
    // 48px of slack, so the button does not flicker at the very bottom.
    const distance = body.scrollHeight - body.scrollTop - body.clientHeight;
    button.hidden = state.view !== 'chat' || distance < 48;
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

    // Nothing said yet: the whole body is the empty state. Once a conversation
    // exists it is gone, rather than sitting above the transcript as a header.
    if (!state.messages.length && !state.sending) return renderEmptyState();

    let html = '';
    // Quick replies hang off the first answer only. After that the
    // conversation has its own momentum and the chips are clutter.
    const firstAnswer = state.messages.findIndex((m) => m.role !== 'user');
    html += state.messages.map((m, index) => {
      const bubble = `<div class="vw-msg ${m.role === 'user' ? 'user' : 'bot'}">${ESC(m.text)}</div>`;
      return bubble + renderBlocks(m.blocks || []) + (index === firstAnswer ? quickReplies() : '');
    }).join('');
    if (state.attachmentUrl) html += `<div class="vw-attachment">Attached: ${ESC(state.attachmentName || 'photo')}</div>`;
    if (state.sending) html += '<div class="vw-msg bot"><span class="vw-typing" role="status" aria-label="Assistant is typing"><span></span><span></span><span></span></span></div>';
    return html;
  }

  /* Logo or wordmark, greeting, starter chips, over a soft vertical gradient.
   * The chips each hug their own text rather than filling the width: a column
   * of full-width bars reads as navigation, this reads as suggestions. */
  function renderEmptyState() {
    const b = state.config || {};
    const t = state.theme || {};
    const logo = SAFE_URL(t.logoUrl) || SAFE_URL(b.logoUrl);
    const mark = logo
      ? `<img class="vw-empty-logo" src="${ESC(logo)}" alt="${ESC(b.brandName || '')}">`
      : `<div class="vw-empty-word">${ESC(b.brandName || '')}</div>`;
    const greeting = t.greeting || b.welcomeMessage || b.brandTagline || '';
    return `<section class="vw-empty-state">${mark}<div class="vw-empty-greeting">${ESC(greeting)}</div>${starterChips()}</section>`;
  }

  /* Theme suggestions first, because they are the tenant's own words. The
   * widget_settings list is the fallback for a deployment that has not set
   * them. */
  function starterQuestions() {
    const t = state.theme || {};
    if (Array.isArray(t.suggestions) && t.suggestions.length) return t.suggestions;
    return (state.config || {}).suggestedQuestions || [];
  }

  function starterChips() {
    const questions = starterQuestions();
    if (!questions.length) return '';
    return '<div class="vw-faqs">' + questions.map((q) => `<button type="button" class="vw-faq" data-question="${ESC(q)}">${ESC(q)}</button>`).join('') + '</div>';
  }

  /* The same chips under the first answer, once, for a customer who is not
   * sure what to ask next. */
  function quickReplies() {
    const questions = starterQuestions().slice(0, 3);
    if (!questions.length) return '';
    return '<div class="vw-faqs vw-quick">' + questions.map((q) => `<button type="button" class="vw-faq" data-question="${ESC(q)}">${ESC(q)}</button>`).join('') + '</div>';
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
    // The code goes in its own element, holding nothing but the code, so what
    // a customer reads is exactly what checkout expects. Previously it sat
    // inline behind a spaced separator, which is how "FEST10" gets copied or
    // retyped with a space in it and then refused at the till.
    if (block.type === 'offers') return `<section class="vw-card"><div class="vw-card-title">Offers</div><div class="vw-offers">${(block.items || []).map((o) => `<div class="vw-offer"><strong>${ESC(o.title)}</strong>${o.code ? `<code class="vw-offer-code">${ESC(String(o.code).replace(/\s+/g, ''))}</code>` : ''}${o.minSpend ? `<span class="vw-offer-min">over ${ESC(o.minSpend)}</span>` : ''}<span class="vw-offer-copy">${ESC(o.description || '')}</span></div>`).join('')}</div></section>`;
    if (block.type === 'order') return renderOrder(block.order);
    // The same panel the orders view renders, so an answer in chat and the
    // panel itself cannot look like two different features.
    if (block.type === 'orders') return (block.orders || []).map((order) => renderOrderPanel(order)).join('');
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

  /* One card in one of three modes.
   *
   * The image fills the card top and the quick-add sits on it, rather than
   * stacking under the copy, so a two-up grid keeps equal heights whatever the
   * titles do. The price is muted: it is information, not the next action, and
   * the accent belongs to the one thing on the screen that is. */
  function renderProduct(p, mode, index) {
    const ref = productRefs.push(p) - 1;
    const { sizes, colors, size, color } = productOptions(p);
    const soldOut = p.inStock === false;
    const ready = !soldOut && Boolean(cartLineFor(p, size, color));

    const image = SAFE_URL(p.imageUrl)
      ? `<img src="${ESC(SAFE_URL(p.imageUrl))}" alt="${ESC(p.name)}">`
      : '';
    // The first of a pair is the one the agent put first, which is the one it
    // is recommending.
    const recommended = mode === 'compare' && index === 0;

    const quickAdd = soldOut
      ? ''
      : `<button type="button" class="vw-quick-add" data-action="add-to-cart" data-product="${ref}"${ready ? '' : ' disabled'} title="Add to cart" aria-label="Add ${ESC(p.name)} to cart">${icon('cart-plus')}</button>`;

    const chips = soldOut ? '' : chipRow(ref, 'size', 'Size', sizes, size)
      + (colors.length > 1 ? chipRow(ref, 'color', 'Colour', colors, color) : '')
      + (colors.length === 1 ? `<div class="vw-product-meta">Colour: ${ESC(colors[0])}</div>` : '');

    const hint = soldOut
      ? '<div class="vw-product-meta">Out of stock</div>'
      : `<div class="vw-product-hint">${ESC(addHintText(sizes, colors, size, color))}</div>`;

    const classes = ['vw-product', `vw-product-${mode}`];
    if (recommended) classes.push('vw-product-recommended');
    if (soldOut) classes.push('vw-product-soldout');

    return `<article class="${classes.join(' ')}"><div class="vw-product-media">${recommended ? '<span class="vw-product-badge">Recommended</span>' : ''}${image}${quickAdd}</div><div class="vw-product-copy"><div class="vw-product-name">${ESC(p.name)}</div><div class="vw-product-price">${ESC(p.price || '')}</div>${chips}${hint}</div></article>`;
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

    const { size, color } = productOptions(product);
    const line = cartLineFor(product, size, color);
    // The button is already disabled in this state; this is the second lock on
    // the same door, because an unbuyable line fails at checkout, not here.
    if (!line) return;

    const written = cartStore.add(
      { id: line.productId, name: line.name, price: line.price, imageUrl: line.imageUrl },
      line.size,
      line.color,
      line.qty
    );
    if (!written) {
      // Only reachable when storage itself refused the write. Saying so beats
      // a button that flashes "Added" over a cart that stayed empty.
      state.messages.push({ role: 'assistant', text: 'Your browser is blocking storage, so I could not save that to the cart.' });
      render();
      return;
    }
    flashAdded(ref);
    refreshCart();
  }

  function flashAdded(ref) {
    const button = shadow.querySelector(`[data-action="add-to-cart"][data-product="${ref}"]`);
    if (!button) return;
    if (addedTimers[ref]) clearTimeout(addedTimers[ref]);
    // The icon button has no label to change, so the confirmation is the fill
    // flipping to accent for a moment.
    button.classList.add('added');
    addedTimers[ref] = setTimeout(() => {
      delete addedTimers[ref];
      const live = shadow.querySelector(`[data-action="add-to-cart"][data-product="${ref}"]`);
      if (live) live.classList.remove('added');
    }, 1400);
  }

  function renderOrder(order) {
    if (!order) return '';
    return `<section class="vw-card"><div class="vw-card-title">Order ${ESC(order.displayId)}</div><div class="vw-status">${ESC(order.status)}</div>${(order.items || []).map((i) => `<div class="vw-order-item"><span>${ESC(i.name)} · ${ESC(i.size)} · ${ESC(i.color)} × ${ESC(i.qty)}</span><span>${ESC(i.price)}</span></div>`).join('')}${order.tracking ? `<div class="vw-order-tracking">Tracking: ${ESC(order.tracking.carrier || '')} ${ESC(order.tracking.number || '')}${SAFE_URL(order.tracking.url) ? ` · <a class="vw-link" href="${ESC(SAFE_URL(order.tracking.url))}" target="_blank" rel="noopener">Open tracking</a>` : ''}</div>` : '<div class="vw-empty vw-order-tracking">Tracking is not available yet.</div>'}</section>`;
  }

  function renderVerify(block) {
    const message = state.verifying ? 'Checking code...' : `Enter the six digit code sent to ${ESC(block.email || state.trackEmail)}.`;
    return `<section class="vw-card"><div class="vw-card-title">Verify your order</div><div class="vw-empty">${message}</div><div class="vw-field vw-code-field"><input class="vw-code" maxlength="6" inputmode="numeric" autocomplete="one-time-code" data-verify-code placeholder="000000"></div><button type="button" class="vw-btn" data-action="verify-code" ${state.verifying ? 'disabled' : ''}>Verify</button><div class="vw-empty" data-verify-msg></div></section>`;
  }

  /* One order.
   *
   * The order ID is the largest, heaviest element here and everything else
   * steps down from it. Exactly one primary button: Track. Report an issue is
   * secondary, and the rest of the actions are ghosts, because a screen with
   * two accent fills has no next step, it has two competing ones. */
  function renderOrderPanel(order) {
    if (!order) return '';
    const cancelled = order.status === 'CANCELLED';
    const stages = order.stages || [];
    const labels = order.stageLabels || {};

    const track = cancelled
      ? '<div class="vw-order-cancelled">This order was cancelled.</div>'
      : `<div class="vw-steps">${stages.map((stage, index) => {
          // Reached, current, and not yet. Future states fade to faint so the
          // eye lands on where the order actually is.
          const cls = index < order.stageIndex ? 'done' : index === order.stageIndex ? 'current' : '';
          return `<div class="vw-step ${cls}"><span class="vw-step-dot"></span><span class="vw-step-label">${ESC(labels[stage] || stage)}</span></div>`;
        }).join('')}</div>`;

    const items = (order.items || []).map((item) => `<div class="vw-order-item"><span>${ESC(item.name)}<br><span class="vw-order-item-variant">${ESC(item.size)} · ${ESC(item.color)} × ${ESC(item.qty)}</span></span><span>${ESC(item.price)}</span></div>`).join('');

    const tracking = order.tracking
      ? `<div class="vw-order-tracking">${ESC(order.tracking.carrier || '')} ${ESC(order.tracking.number || '')}${SAFE_URL(order.tracking.url) ? ` · <a class="vw-link" href="${ESC(SAFE_URL(order.tracking.url))}" target="_blank" rel="noopener noreferrer">Open tracking</a>` : ''}</div>`
      : '<div class="vw-order-tracking vw-empty">Tracking is not available yet.</div>';

    // Track is the single primary. Cancel and Return are ghosts rather than
    // secondaries: they are rarer and more consequential, and should not look
    // like the obvious next tap.
    const actions = [
      `<button type="button" class="vw-btn" data-action="order-track" data-order="${ESC(order.displayId)}">Track</button>`,
      `<button type="button" class="vw-btn secondary" data-action="order-issue" data-order="${ESC(order.displayId)}">Report an issue</button>`,
      order.canRequestReturn ? `<button type="button" class="vw-btn ghost" data-action="order-return" data-order="${ESC(order.displayId)}">Return items</button>` : '',
      order.canCancel ? `<button type="button" class="vw-btn ghost" data-action="order-cancel" data-order="${ESC(order.displayId)}">Cancel order</button>` : '',
    ].filter(Boolean).join('');

    return `<section class="vw-card"><div class="vw-order-id">${ESC(order.displayId)}</div><div class="vw-order-status">${ESC(order.statusLabel || order.status)}</div>${track}${items}<div class="vw-order-total"><span class="vw-empty">Total</span><strong>${ESC(order.total || '')}</strong></div>${tracking}<div class="vw-actions">${actions}</div>${renderReturnForm(order)}</section>`;
  }

  /* Opened by Return or Report an issue. Send for review is the one primary,
   * Attach a photo is secondary, Not now is a ghost. */
  function renderReturnForm(order) {
    if (state.returnFor !== order.displayId) return '';
    const reasons = ['Wrong size', 'Damaged item', 'Not as described', 'Changed my mind'];
    const rows = (order.items || []).map((item) => `<label class="vw-return-row"><input type="checkbox" data-return-item="${ESC(item.itemId)}"${state.returnItems[item.itemId] ? ' checked' : ''}> <span>${ESC(item.name)} <span class="vw-order-item-variant">${ESC(item.size)} · ${ESC(item.color)}</span></span></label>`).join('');
    // Nothing may be sent until an item and a reason are both chosen. The
    // reason opens empty rather than on whichever option happened to be first.
    const chosenItem = Object.keys(state.returnItems).some((key) => state.returnItems[key]);
    const ready = chosenItem && Boolean(state.returnReason);
    return `<div class="vw-return-form"><div class="vw-card-title">What went wrong?</div>${rows}<div class="vw-field"><label for="vw-return-reason">Reason</label><select id="vw-return-reason" data-return-reason><option value="" ${state.returnReason ? '' : 'selected'} disabled>Select a reason</option>${reasons.map((r) => `<option value="${ESC(r)}"${r === state.returnReason ? ' selected' : ''}>${ESC(r)}</option>`).join('')}</select></div>${state.attachmentUrl ? `<div class="vw-attachment">Photo attached: ${ESC(state.attachmentName || 'photo')}</div>` : '<button type="button" class="vw-btn secondary" data-action="attach">Attach a photo</button>'}<div class="vw-actions"><button type="button" class="vw-btn" data-action="return-submit"${state.returnSubmitting || !ready ? ' disabled' : ''}>${state.returnSubmitting ? 'Sending...' : 'Send for review'}</button><button type="button" class="vw-btn ghost" data-action="return-cancel">Not now</button></div>${state.returnError ? `<div class="vw-order-error">${ESC(state.returnError)}</div>` : ''}<div class="vw-empty">This is a request. A person reviews it and emails you the decision.</div></div>`;
  }

  function renderOrders() {
    if (!state.verified) {
      return `<section class="vw-card"><div class="vw-card-title">Your orders</div><div class="vw-empty">Verify your email to see an order.</div><div class="vw-actions"><button type="button" class="vw-btn" data-action="track">Verify</button></div></section>`;
    }
    let html = '';
    if (state.ordersNotice) html += `<div class="vw-order-notice">${ESC(state.ordersNotice)}</div>`;
    if (state.ordersError) html += `<div class="vw-order-error">${ESC(state.ordersError)}</div>`;
    if (state.ordersLoading && !state.orders) {
      html += '<section class="vw-card"><div class="vw-empty">Loading your order...</div></section>';
      return html;
    }
    if (state.orders && state.orders.length) {
      html += state.orders.map((order) => renderOrderPanel(order)).join('');
    } else if (state.orders) {
      html += '<section class="vw-card"><div class="vw-card-title">Your orders</div><div class="vw-empty">We could not find an order for this session.</div></section>';
    }
    // All three are ghosts: none of them is the next step, they are ways out.
    // Sign out sits last and quietest, because it is the one that undoes work.
    html += `<div class="vw-actions footer"><button type="button" class="vw-btn ghost" data-action="refresh-order">Refresh</button><button type="button" class="vw-btn ghost" data-action="back-to-chat">Ask a question</button><button type="button" class="vw-btn ghost quiet" data-action="signout">Sign out</button></div>`;
    return html;
  }

  function renderTrack() {
    if (state.verified) return `<section class="vw-card"><div class="vw-card-title">Signed in</div><div class="vw-empty">Your order is linked to this session.</div><div class="vw-actions"><button type="button" class="vw-btn" data-action="refresh-order">Show order status</button><button type="button" class="vw-btn secondary" data-action="signout">Sign out</button></div></section>`;
    return `<section class="vw-card"><div class="vw-card-title">Track orders</div><div class="vw-field"><label>Email used at checkout</label><input type="email" data-track-email value="${ESC(state.trackEmail)}"></div><div class="vw-field"><label>Order ID</label><input data-track-order value="${ESC(state.trackOrderId)}" placeholder="VEL-XXXXXX"></div>${state.codeSent ? `<div class="vw-field"><label>Six digit code</label><input class="vw-code" data-track-code maxlength="6" inputmode="numeric"></div><div class="vw-actions"><button type="button" class="vw-btn" data-action="track-verify">Verify code</button></div>` : `<button type="button" class="vw-btn" data-action="request-code">Email me a code</button>`}<div class="vw-empty" data-track-msg></div></section>`;
  }

  /* ------------------------------ the cart ------------------------------ */

  /* The widget must not depend on the host page having a cart.
   *
   * On this project's own storefront, api.js owns the cart. On a client site
   * the embed is the only script we control: there is no api.js, no window.API
   * and no window.Cart, and a widget that assumed otherwise would write to
   * nothing. So the adapter resolves a backend per call, in order of how
   * authoritative it is:
   *
   *   1. window.SahaayCart, a bridge a host page can implement to own the
   *      cart itself (a React store, a Shopify cart, anything).
   *   2. window.Cart, which is this project's own api.js.
   *   3. localStorage under the same key api.js uses, driven from here.
   *
   * Resolved per call rather than once at load, because the widget script can
   * execute before the page's own scripts have defined either global.
   *
   * The third path is what makes a standalone embed work, and it is the same
   * storage api.js reads, so the two stay in agreement whenever both exist.
   */
  const CART_KEY = 'velour_cart';

  function cartBridge() {
    const bridge = window.SahaayCart;
    if (bridge && typeof bridge.get === 'function' && typeof bridge.add === 'function') return bridge;
    const host = window.Cart;
    if (host && typeof host.get === 'function' && typeof host.add === 'function') return host;
    return null;
  }

  function localCartRead() {
    try {
      const parsed = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
      // Private browsing, a blocked origin, or something else's data under the
      // same key. An empty cart is the only safe reading.
      return [];
    }
  }

  function localCartWrite(lines) {
    try {
      localStorage.setItem(CART_KEY, JSON.stringify(lines));
    } catch (err) {
      // Storage is unavailable. The line is lost, which the caller surfaces.
      return false;
    }
    // The same event api.js dispatches, so a host page that listens for its
    // own cart changes sees the widget's writes too.
    try {
      document.dispatchEvent(new CustomEvent('velour:cart-change'));
    } catch (err) { /* very old engines */ }
    return true;
  }

  const cartStore = {
    /* Re-read at the point of use, never held between renders: the storefront
     * and the widget both write to this and either one goes stale the moment
     * the other changes it. */
    get() {
      const bridge = cartBridge();
      if (bridge) {
        try {
          const lines = bridge.get();
          return Array.isArray(lines) ? lines : [];
        } catch (err) {
          return [];
        }
      }
      return localCartRead();
    },

    /* Same merge rule as api.js: one line per product/size/colour, quantities
     * added. Duplicating it is deliberate, because the localStorage path has
     * no api.js to call. */
    add(product, size, color, qty) {
      const bridge = cartBridge();
      if (bridge) {
        bridge.add(product, size, color, qty);
        return true;
      }
      const lines = localCartRead();
      const existing = lines.find((l) => l.productId === product.id && l.size === size && l.color === color);
      if (existing) existing.qty += qty;
      else lines.push({ productId: product.id, name: product.name, price: product.price, iconKey: product.iconKey, imageUrl: product.imageUrl, size, color, qty });
      return localCartWrite(lines);
    },

    clear() {
      const bridge = cartBridge();
      if (bridge && typeof bridge.clear === 'function') { bridge.clear(); return true; }
      return localCartWrite([]);
    },
  };

  function cartLines() {
    return cartStore.get();
  }

  function cartCount() {
    return cartLines().reduce((sum, line) => sum + (Number(line.qty) || 0), 0);
  }

  /* Re-reads and repaints, but only when the panel is actually showing the
   * cart or the checkout built from it. Anywhere else there is nothing on
   * screen that could be stale, and a render would cost the customer whatever
   * they had typed in the message field. */
  function refreshCart() {
    if (!shadow || !state.config) return;
    // The badge is always live, whatever view is open, because it is on the
    // header and the header is always on screen.
    refreshBadge();
    if (state.view === 'cart' || state.view === 'checkout') render();
  }

  function renderCart() {
    const cart = cartLines();
    return `<section class="vw-card"><div class="vw-card-title">Your cart</div>${cart.length ? cart.map((line) => `<div class="vw-cart-line">${SAFE_URL(line.imageUrl) ? `<img src="${ESC(SAFE_URL(line.imageUrl))}" alt="">` : ''}<div class="vw-cart-info"><div class="vw-cart-name">${ESC(line.name)}</div><div class="vw-cart-meta">${ESC(line.size)}, ${ESC(line.color)} × ${ESC(line.qty)}</div></div><strong>${ESC(money(line.price * line.qty))}</strong></div>`).join('') + `<div class="vw-actions"><button type="button" class="vw-btn" data-action="checkout">Checkout</button></div>` : '<div class="vw-empty">Your cart is empty. Add something from the storefront.</div>'}</section>`;
  }

  function renderCheckout() {
    if (!cartLines().length) return '<section class="vw-card"><div class="vw-card-title">Checkout</div><div class="vw-empty">Your cart is empty.</div></section>';
    return `<section class="vw-card"><div class="vw-card-title">Secure checkout</div><form data-checkout-form><div class="vw-field"><label>Full name</label><input name="name" required></div><div class="vw-field"><label>Email</label><input name="email" type="email" required></div><div class="vw-field"><label>Phone</label><input name="phone" required></div><div class="vw-field"><label>Address</label><input name="address" required></div><div class="vw-field"><label>City</label><input name="city" required></div><div class="vw-field"><label>State</label><input name="state" required></div><div class="vw-field"><label>PIN code</label><input name="pincode" required></div><div class="vw-field"><label>Offer code (optional)</label><input name="offerCode" autocomplete="off"></div><button type="submit" class="vw-btn" ${state.cartSubmitting ? 'disabled' : ''}>Pay securely</button><div class="vw-empty" data-checkout-msg></div></form></section>`;
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
      // The server reached us but could not reach the model. For a verified
      // customer that must not end the road: their order is a database read
      // this widget can do on its own.
      if (data.degraded) await fallBackToOrders();
    } catch (err) {
      state.messages.push({ role: 'assistant', text: err.message || 'I am having trouble reaching the assistant right now.' });
      // Covers the other half: a rate limit or a 5xx, where the request itself
      // failed. A throttled chat must never block an order lookup.
      await fallBackToOrders();
    } finally {
      state.sending = false;
      saveHistory();
      render();
    }
  }

  /* Called when the model is unreachable. For a verified customer it swaps the
   * apology for the thing they were almost certainly asking about; for anyone
   * else it changes nothing, because there is no order to show. */
  async function fallBackToOrders() {
    if (!state.verified) return;
    state.ordersNotice = 'The assistant is unavailable right now, so here is your order directly.';
    try {
      await loadOrders({ view: 'orders' });
    } catch (err) {
      // loadOrders already records its own error into state.
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
      state.verifiedEmail = data.email || state.verifiedEmail;
      state.messages.push({ role: 'assistant', text: `Verified for order ${data.orderDisplayId}.` });
      saveHistory();
      // Straight to the panel: verifying is the moment they wanted the order,
      // and reading it costs one database call, not a model round trip.
      await loadOrders({ view: 'orders' });
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
      state.verifiedEmail = data.email || '';
    } catch (err) { state.verified = false; }
  }

  /* ---------------------------- orders panel ---------------------------- */

  /* Reading an order is a database call. This used to post "Show me my order
   * status" into the chat and wait for the model to decide to call a tool,
   * which put a language model, its rate limit and its bill between a verified
   * customer and a row they had already proved they can read. */
  async function loadOrders({ view } = {}) {
    if (view) state.view = view;
    state.ordersLoading = true;
    state.ordersError = '';
    render();
    try {
      const data = await request('/api/orders/mine', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sessionId() }),
      });
      state.orders = data.orders || [];
      state.verifiedEmail = data.email || state.verifiedEmail;
      state.verified = true;
    } catch (err) {
      // A 401 here means the cookie expired since the panel was drawn.
      if (/not_verified/i.test(err.message || '')) {
        state.verified = false;
        state.orders = null;
        state.ordersError = 'Your session expired. Verify again to see your order.';
      } else {
        state.ordersError = err.message || 'Could not load your order right now.';
      }
    } finally {
      state.ordersLoading = false;
      render();
    }
  }

  async function showOrderStatus() {
    state.ordersNotice = '';
    await loadOrders({ view: 'orders' });
  }

  async function cancelVerifiedOrder(displayId) {
    const order = (state.orders || []).find((o) => o.displayId === displayId);
    if (!order) return;
    // Cancelling cannot be undone and, on a paid order, starts a refund
    // review. One deliberate confirmation rather than a single mis-click.
    const warning = order.status === 'PENDING_PAYMENT'
      ? `Cancel order ${order.displayId}? Nothing has been charged.`
      : `Cancel order ${order.displayId}? A refund of what you paid will be sent to our team for review.`;
    if (!window.confirm(warning)) return;

    state.ordersLoading = true;
    state.ordersError = '';
    render();
    try {
      const result = await request('/api/orders/mine/cancel', {
        method: 'POST',
        body: JSON.stringify({ sessionId: sessionId() }),
      });
      state.ordersNotice = result.message || 'Your order is cancelled.';
      // Re-read rather than patching in place, so the steps and the buttons
      // both come from what the server now holds.
      await loadOrders();
      return;
    } catch (err) {
      state.ordersError = err.message || 'That order could not be cancelled.';
    } finally {
      state.ordersLoading = false;
      render();
    }
  }

  function openReturnForm(displayId) {
    state.returnFor = displayId;
    // Not preseeded from which button was pressed: Report an issue and Return
    // are two ways into the same form, and neither knows what went wrong.
    state.returnReason = '';
    state.returnItems = {};
    state.returnError = '';
    state.ordersNotice = '';
    state.view = 'orders';
    render();
  }

  async function submitReturn() {
    const order = (state.orders || []).find((o) => o.displayId === state.returnFor);
    if (!order) return;
    const items = Object.keys(state.returnItems)
      .filter((itemId) => state.returnItems[itemId])
      .map((itemId) => ({ orderItemId: itemId, quantity: 1 }));
    if (!items.length) {
      state.returnError = 'Pick at least one item.';
      render();
      return;
    }
    if (!state.returnReason) {
      state.returnError = 'Choose a reason.';
      render();
      return;
    }

    state.returnSubmitting = true;
    state.returnError = '';
    render();
    try {
      // Straight to /api/returns, the same endpoint the tracking page posts
      // to. The email comes from the verified session, not from a field the
      // customer could point at someone else's order.
      const result = await request('/api/returns', {
        method: 'POST',
        body: JSON.stringify({
          displayId: order.displayId,
          email: state.verifiedEmail,
          items,
          reason: state.returnReason,
          description: '',
          photoUrl: state.attachmentUrl || undefined,
        }),
      });
      state.returnFor = null;
      state.returnItems = {};
      state.attachmentUrl = null;
      state.attachmentName = '';
      state.ordersNotice = `Request ${result.displayId} has been sent for review. You will get an email with the decision.`;
      await loadOrders();
      return;
    } catch (err) {
      state.returnError = err.message || 'That request could not be sent.';
    } finally {
      state.returnSubmitting = false;
      render();
    }
  }

  async function signout() {
    await request('/api/session/signout', { method: 'POST', body: JSON.stringify({}) });
    state.verified = false; state.activeOrder = null; state.codeSent = false; state.messages = [];
    state.orders = null; state.verifiedEmail = ''; state.ordersNotice = ''; state.ordersError = ''; state.returnFor = null;
    state.view = 'chat';
    // Clears the stored copy as well, otherwise signing out empties the panel
    // and the next page brings the whole conversation back.
    saveHistory();
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
            cartStore.clear();
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
    // The send button appears with content rather than sitting there greyed
    // out, so it is only ever an invitation to press it.
    shadow.querySelector('[data-chat-input]')?.addEventListener('input', syncComposer);
    shadow.querySelector('[data-body]')?.addEventListener('scroll', syncScrollButton, { passive: true });
    shadow.querySelector('[data-action="scroll-end"]')?.addEventListener('click', () => {
      const body = shadow.querySelector('[data-body]');
      if (!body) return;
      try { body.scrollTo({ top: body.scrollHeight, behavior: 'smooth' }); }
      catch (err) { body.scrollTop = body.scrollHeight; }
    });
    // One back affordance for every subview, so a customer is never stranded
    // somewhere with no way to the conversation.
    shadow.querySelector('[data-action="back"]')?.addEventListener('click', () => {
      if (state.view === 'orders' && state.orderDetail) { state.orderDetail = null; render(); return; }
      if (state.view === 'checkout') { state.view = 'cart'; render(); return; }
      state.view = 'chat';
      render();
    });
    shadow.querySelector('[data-file]').addEventListener('change', async (event) => {
      const file = event.target.files && event.target.files[0]; if (!file) return;
      try { await uploadPhoto(file); } catch (err) { state.messages.push({ role: 'assistant', text: err.message || 'Could not attach that photo.' }); render(); }
    });
    shadow.querySelectorAll('[data-question]').forEach((el) => el.addEventListener('click', () => sendChat(el.getAttribute('data-question'))));
    shadow.querySelectorAll('[data-action="add-to-cart"]').forEach((el) => el.addEventListener('click', () => addProductToCart(el.getAttribute('data-product'))));
    shadow.querySelectorAll('[data-chip]').forEach((el) => el.addEventListener('click', () => selectChip(el)));
    shadow.querySelector('[data-action="cart"]')?.addEventListener('click', () => { state.view = 'cart'; render(); });
    shadow.querySelector('[data-action="track"]')?.addEventListener('click', () => {
      // Already verified means there is nothing to ask for: show the order.
      if (state.verified) { showOrderStatus(); return; }
      state.view = 'track';
      render();
    });
    shadow.querySelector('[data-action="request-code"]')?.addEventListener('click', requestCode);
    shadow.querySelector('[data-action="track-verify"]')?.addEventListener('click', () => verifyDirect(shadow.querySelector('[data-track-code]').value.trim(), shadow.querySelector('[data-track-msg]')));
    shadow.querySelector('[data-action="signout"]')?.addEventListener('click', signout);
    shadow.querySelector('[data-action="refresh-order"]')?.addEventListener('click', showOrderStatus);
    shadow.querySelector('[data-action="back-to-chat"]')?.addEventListener('click', () => { state.view = 'chat'; render(); });
    // Every order action is a direct API call. None of them send a chat
    // message, so none of them can be blocked by the model.
    shadow.querySelectorAll('[data-action="order-track"]').forEach((el) => el.addEventListener('click', () => {
      state.ordersNotice = '';
      loadOrders();
    }));
    shadow.querySelectorAll('[data-action="order-cancel"]').forEach((el) => el.addEventListener('click', () => cancelVerifiedOrder(el.getAttribute('data-order'))));
    shadow.querySelectorAll('[data-action="order-return"]').forEach((el) => el.addEventListener('click', () => openReturnForm(el.getAttribute('data-order'))));
    shadow.querySelectorAll('[data-action="order-issue"]').forEach((el) => el.addEventListener('click', () => openReturnForm(el.getAttribute('data-order'))));
    // Both re-render, because Send for review is disabled until an item and a
    // reason are both chosen and its state has to follow the choice.
    shadow.querySelectorAll('[data-return-item]').forEach((el) => el.addEventListener('change', () => {
      state.returnItems[el.getAttribute('data-return-item')] = el.checked;
      render();
    }));
    shadow.querySelector('[data-return-reason]')?.addEventListener('change', (event) => {
      state.returnReason = event.target.value;
      render();
    });
    shadow.querySelector('[data-action="return-submit"]')?.addEventListener('click', submitReturn);
    shadow.querySelector('[data-action="return-cancel"]')?.addEventListener('click', () => {
      state.returnFor = null; state.returnError = ''; render();
    });
    shadow.querySelector('[data-action="checkout"]')?.addEventListener('click', () => { state.view = 'checkout'; render(); });
    shadow.querySelector('[data-action="verify-code"]')?.addEventListener('click', () => {
      const code = shadow.querySelector('[data-verify-code]').value.trim();
      verifyDirect(code, shadow.querySelector('[data-verify-msg]'));
    });
    shadow.querySelector('[data-checkout-form]')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      // window.API was undefined for the same reason window.Cart was, and on a
      // standalone embed there is no api.js to provide it at all. The widget's
      // own request() reaches the same endpoint either way.
      const checkout = (payload) => (window.API && typeof window.API.checkout === 'function')
        ? window.API.checkout(payload)
        : request('/api/orders/checkout', { method: 'POST', body: JSON.stringify(payload) });
      state.cartSubmitting = true; render();
      try {
        const values = Object.fromEntries(new FormData(shadow.querySelector('[data-checkout-form]')).entries());
        const cart = cartLines();
        // Only the code travels. The discount is recomputed server side from
        // the offers table, so nothing typed here can change the amount
        // charged.
        const offerCode = (values.offerCode || '').trim();
        delete values.offerCode;
        const order = await checkout({ idempotencyKey: crypto.randomUUID(), items: cart.map((l) => ({ productId: l.productId, size: l.size, color: l.color, qty: l.qty })), customer: values, offerCode: offerCode || undefined });
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
    state.messages = loadHistory();
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
    // api.js fires this on every cart write, from either side. Without it the
    // widget's open cart panel keeps showing what the cart held when it was
    // opened while the storefront shows something else.
    document.addEventListener('velour:cart-change', refreshCart);

    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
