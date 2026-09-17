(function () {
  'use strict';

  if (window.__VELOUR_EMBED_LOADER__) return;
  window.__VELOUR_EMBED_LOADER__ = true;

  const script = document.currentScript;
  const apiBase = ((script && script.getAttribute('data-api')) || window.VELOUR_WIDGET_API || (script && script.src ? new URL(script.src).origin : '')).replace(/\/$/, '');
  const widgetUrl = new URL('/js/widget.js', apiBase || window.location.origin).href;
  const loader = document.createElement('script');
  loader.src = widgetUrl;
  loader.async = true;
  loader.setAttribute('data-api', apiBase);
  // Keep the standalone embed on the exact same widget source as the demo
  // storefront so style and security fixes cannot drift between two copies.
  (document.head || document.documentElement).appendChild(loader);
})();
