/* Brand token applier.
 *
 * The API is the source of truth, so a dashboard change takes effect on the
 * next config fetch with no rebuild and no redeploy. This replaced the old
 * first-letter logo trick that made every client look identical.
 *
 * Two families of variables are written. The --brand-* names are the widget
 * and embed contract. The second group are the names the storefront
 * stylesheet in css/main.css actually consumes, which is the part that was
 * missed the first time: without them a client-branded widget sat on top of
 * an unchanged purple storefront, which looks broken in a demo recording.
 */
window.VELOUR_BRAND = null;

async function loadBrand() {
  try {
    const data = await getConfig();
    const brand = data.brand || data;
    window.VELOUR_BRAND = { name: data.brandName, tagline: data.brandTagline, ...brand };
    applyBrand(window.VELOUR_BRAND);
    document.dispatchEvent(new CustomEvent('velour:brand-ready', { detail: window.VELOUR_BRAND }));
  } catch (err) {
    console.error('Could not load brand config', err);
  }
}

/* Only http and https URLs are ever written into markup. The API and a
 * database constraint both reject anything else, and this is the third
 * check, because this is the one place the value becomes an attribute. */
function safeUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value) ? value : '';
}

/** Blends two colours in the browser rather than shipping a palette
 * generator. Every derived shade stays tied to the client's accent, so one
 * hex in the dashboard restyles the whole storefront coherently. */
function mix(color, other, percent) {
  return `color-mix(in srgb, ${color} ${percent}%, ${other})`;
}

function applyBrand(brand) {
  const root = document.documentElement;
  const accent = brand.accent;
  const surface = brand.surface;
  const radius = Number(brand.borderRadius);

  const tokens = {
    // Widget and embed contract.
    '--brand-accent': accent,
    '--brand-secondary': brand.secondary,
    '--brand-background': brand.background,
    '--brand-surface': surface,
    '--brand-text': brand.textColor,
    '--brand-muted': brand.mutedColor,
    '--brand-radius': Number.isFinite(radius) ? `${radius}px` : null,
    '--brand-font-family': brand.fontFamily,
    '--brand-logo-height': brand.logoHeight ? `${brand.logoHeight}px` : null,

    // Names css/main.css actually reads. Without these the storefront keeps
    // its built-in palette no matter what the dashboard says.
    '--brand-accent-deep': accent ? mix(accent, '#000000', 72) : null,
    '--brand-accent-ink': accent ? mix(accent, '#000000', 38) : null,
    '--ink': brand.textColor,
    '--muted': brand.mutedColor,
    '--white': surface,
    '--lavender': accent && surface ? mix(accent, surface, 10) : null,
    '--lavender-soft': accent && surface ? mix(accent, surface, 18) : null,
    '--border': accent && surface ? mix(accent, surface, 22) : null,
    '--font-body': brand.fontFamily,
    '--radius-sm': Number.isFinite(radius) ? `${Math.round(radius * 0.55)}px` : null,
    '--radius-md': Number.isFinite(radius) ? `${radius}px` : null,
    '--radius-lg': Number.isFinite(radius) ? `${Math.round(radius * 1.35)}px` : null,
  };

  Object.entries(tokens).forEach(([name, value]) => {
    if (value != null && value !== '') root.style.setProperty(name, value);
  });

  document.querySelectorAll('[data-brand-name]').forEach((el) => { el.textContent = brand.name || ''; });
  document.querySelectorAll('[data-brand-tagline]').forEach((el) => { el.textContent = brand.tagline || ''; });

  const logo = safeUrl(brand.logoUrl);
  document.querySelectorAll('[data-brand-logo]').forEach((el) => {
    if (!logo) return;
    el.setAttribute('src', logo);
    el.setAttribute('alt', brand.name || '');
    el.hidden = false;
  });

  const titleEl = document.querySelector('title');
  if (titleEl && titleEl.getAttribute('data-brand-title-suffix')) {
    titleEl.textContent = titleEl.getAttribute('data-brand-title-suffix').replace('{brand}', brand.name || 'Store');
  }
}

document.addEventListener('DOMContentLoaded', loadBrand);
