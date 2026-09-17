/* The widget's theme, resolved.
 *
 * Four layers, later wins:
 *   1. the defaults below, mirroring the :root block in css/widget.css
 *   2. SAHAAY_* environment variables
 *   3. the widget_theme row an admin edits in the dashboard
 *   4. data-* attributes on the embed script tag, applied in the browser
 *
 * Layers 1 to 3 combine here and go out over GET /api/widget/config. Layer 4
 * is the browser's business, because only the browser can see the script tag.
 *
 * Every value that reaches a stylesheet is validated first. These end up
 * inside a style attribute and as CSS custom property values, so an
 * unvalidated string would be a stored-XSS vector wearing a colour's clothes:
 * a "colour" of `red;}html{display:none` would escape its declaration. Nothing
 * that fails its check is passed through and repaired; it is dropped, and the
 * layer beneath it wins instead.
 */

const db = require('./db');
const { env } = require('../config/env');

/* Layer 1. Duplicated in the :root block of css/widget.css on purpose: the
 * stylesheet has to render correctly on its own when a page loads the CSS
 * before the config request answers, and these are what it falls back to. */
const DEFAULTS = {
  accent: '#6C5FFF',
  // Near-white rather than #FFF: pure white on a saturated fill vibrates,
  // and the rest of the palette already avoids pure black for the same reason.
  accentInk: '#FDFDFD',
  bg: '#FFFFFF',
  tintFrom: '#FFFFFF',
  tintTo: '#F4F2FF',
  ink: '#1A1A1A',
  radiusShell: 24,
  radiusCard: 16,
  font: 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  headerStyle: 'floating',
  density: 'comfortable',
  logoUrl: '',
  greeting: '',
  suggestions: [],
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;
/* Deliberately narrow: letters, digits, spaces, commas, hyphens, dots and
 * quotes. That covers every real font stack and excludes the semicolons,
 * braces and parentheses that would let a value break out of its declaration
 * or smuggle in a url(). */
const FONT_STACK = /^[\w\s,'"().-]{1,200}$/;

function cleanColor(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX.test(trimmed) ? trimmed : null;
}

function cleanRadius(value, max) {
  // Number('') is 0, and 0 is a legitimate radius, so a blank value would
  // resolve to square corners instead of falling through to the layer below.
  // Blank has to be rejected before the coercion, not after it.
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= 0 && rounded <= max ? rounded : null;
}

function cleanFont(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  // url() and @import are how a font value turns into a network request the
  // deployment never agreed to. A Google Font goes in as a family name; the
  // page is responsible for loading it.
  if (/url\s*\(|@import|[;{}]/i.test(trimmed)) return null;
  return FONT_STACK.test(trimmed) ? trimmed : null;
}

function cleanEnum(value, allowed) {
  return typeof value === 'string' && allowed.includes(value.trim()) ? value.trim() : null;
}

/* Only http and https, the same rule every other URL in this codebase goes
 * through, because this one becomes an <img src>. */
function cleanUrl(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^https?:\/\//i.test(trimmed) && trimmed.length <= 1000 ? trimmed : null;
}

function cleanText(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : null;
}

/* 3 to 5 strings. Accepts a real array (from JSONB) or a JSON string (from an
 * environment variable). Anything else, or the wrong length, is no opinion at
 * all rather than a partial list. */
function cleanSuggestions(value) {
  let list = value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      list = JSON.parse(trimmed);
    } catch (err) {
      console.error('SAHAAY_SUGGESTIONS is not valid JSON, ignoring it.');
      return null;
    }
  }
  if (!Array.isArray(list)) return null;
  const strings = list
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 120));
  if (strings.length < 3 || strings.length > 5) return null;
  return strings;
}

/* Applies one layer over another. A null or undefined in the upper layer
 * means "no opinion", so the lower layer shows through. */
function overlay(base, upper) {
  const merged = { ...base };
  Object.keys(upper).forEach((key) => {
    if (upper[key] !== null && upper[key] !== undefined) merged[key] = upper[key];
  });
  return merged;
}

function fromEnv() {
  return {
    accent: cleanColor(env.SAHAAY_ACCENT),
    accentInk: cleanColor(env.SAHAAY_ACCENT_INK),
    bg: cleanColor(env.SAHAAY_BG),
    tintFrom: cleanColor(env.SAHAAY_TINT_FROM),
    tintTo: cleanColor(env.SAHAAY_TINT_TO),
    ink: cleanColor(env.SAHAAY_INK),
    radiusShell: cleanRadius(env.SAHAAY_RADIUS_SHELL, 64),
    radiusCard: cleanRadius(env.SAHAAY_RADIUS_CARD, 48),
    font: cleanFont(env.SAHAAY_FONT),
    headerStyle: cleanEnum(env.SAHAAY_HEADER_STYLE, ['floating', 'solid']),
    density: cleanEnum(env.SAHAAY_DENSITY, ['comfortable', 'compact']),
    logoUrl: cleanUrl(env.SAHAAY_LOGO_URL),
    greeting: cleanText(env.SAHAAY_GREETING, 200),
    suggestions: cleanSuggestions(env.SAHAAY_SUGGESTIONS),
  };
}

function fromRow(row) {
  if (!row) return {};
  return {
    accent: cleanColor(row.accent),
    accentInk: cleanColor(row.accentInk),
    bg: cleanColor(row.bg),
    tintFrom: cleanColor(row.tintFrom),
    tintTo: cleanColor(row.tintTo),
    ink: cleanColor(row.ink),
    radiusShell: cleanRadius(row.radiusShell, 64),
    radiusCard: cleanRadius(row.radiusCard, 48),
    font: cleanFont(row.font),
    headerStyle: cleanEnum(row.headerStyle, ['floating', 'solid']),
    density: cleanEnum(row.density, ['comfortable', 'compact']),
    logoUrl: cleanUrl(row.logoUrl),
    greeting: cleanText(row.greeting, 200),
    suggestions: cleanSuggestions(row.suggestions),
  };
}

async function readThemeRow() {
  try {
    const result = await db.query(
      `SELECT accent, accent_ink AS "accentInk", bg, tint_from AS "tintFrom", tint_to AS "tintTo",
              ink, radius_shell AS "radiusShell", radius_card AS "radiusCard", font,
              header_style AS "headerStyle", density, logo_url AS "logoUrl",
              greeting, suggestions
         FROM widget_theme WHERE id = 1`
    );
    return result.rows[0] || null;
  } catch (err) {
    // A missing table (migration not run yet) or an unreachable database must
    // not take the widget down. Env and defaults still make a whole theme.
    console.error('Could not read widget_theme, falling back to env and defaults:', err.message);
    return null;
  }
}

/**
 * Layers 1 to 3, combined and validated.
 * @returns {object} every key present, no nulls
 */
async function resolveTheme() {
  const row = await readThemeRow();
  return overlay(overlay(DEFAULTS, fromEnv()), fromRow(row));
}

/* The same shape the browser sets on the widget root. Kept here rather than in
 * the client so the server can inline the identical declarations into the
 * embed's first paint, which is what stops the unstyled frame.
 *
 * Derived values (accent-soft, the ink tints, shadows) are expressed in terms
 * of the tokens above using color-mix, so one accent restyles everything and
 * there is no second palette to keep in step. */
function themeToCssVars(theme) {
  return {
    '--sah-accent': theme.accent,
    '--sah-accent-ink': theme.accentInk,
    '--sah-accent-soft': `color-mix(in srgb, ${theme.accent} 8%, transparent)`,
    '--sah-bg': theme.bg,
    '--sah-bg-tint-from': theme.tintFrom,
    '--sah-bg-tint-to': theme.tintTo,
    '--sah-ink': theme.ink,
    '--sah-ink-muted': `color-mix(in srgb, ${theme.ink} 58%, ${theme.bg})`,
    '--sah-ink-faint': `color-mix(in srgb, ${theme.ink} 32%, ${theme.bg})`,
    '--sah-line': `color-mix(in srgb, ${theme.ink} 10%, ${theme.bg})`,
    '--sah-radius-shell': `${theme.radiusShell}px`,
    '--sah-radius-card': `${theme.radiusCard}px`,
    '--sah-font': theme.font,
  };
}

/** The declarations as a string, for a style attribute or a <style> block. */
function themeToCssText(theme) {
  return Object.entries(themeToCssVars(theme))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');
}

module.exports = {
  resolveTheme,
  themeToCssVars,
  themeToCssText,
  DEFAULTS,
  // Exported for the admin route, which validates the same way before writing.
  cleanColor,
  cleanRadius,
  cleanFont,
  cleanEnum,
  cleanUrl,
  cleanText,
  cleanSuggestions,
};
