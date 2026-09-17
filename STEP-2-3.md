# Steps 2 and 3

## What changed

Step 2 adds migration `011_brand_config.sql` with a single-row `brand_config` table and sensible seeded defaults. `/api/config` now merges the database row over the validated environment layer, including the existing shipping values through `src/config/env.js` rather than reading `process.env` in the route.

The admin API now has `GET /api/admin/brand` and `PUT /api/admin/brand`, plus full offer CRUD at `GET/POST/PUT/DELETE /api/admin/offers`. Offers support the existing `PERCENT`, `FLAT`, `FREE_SHIPPING`, and `BUNDLE` kinds. Brand and offer payloads are validated in `src/schemas/index.js`.

Brand images use the existing upload and magic-byte validation path under a new `brand` S3 folder. Helmet now permits HTTPS/data fonts and the configured brand logo origin.

`public/js/brand.js` is now a token applier. It no longer manufactures a first-letter logo, so a widget client is not visually tied to a fake shared identity.

Step 3 makes `public/js/widget.js` the single widget implementation. `embed/velour-chat.js` is only a loader for that same source, which prevents the demo and embed versions drifting apart. The widget uses Shadow DOM and keeps its injected stylesheet outside the re-rendered content, avoiding the previous stylesheet destruction bug.

The widget now consumes all six chat block types: product cards, offer chips, order status/tracking, direct six-digit verification, pending proposal receipts, and upload prompts. Verification posts directly to `/api/session/verify` and never sends the code through `/api/chat`.

Track Orders is now an email/order-code login flow with session restoration through `/api/session/state` and sign-out through `/api/session/signout`. Chat photo attachment uploads through `/api/uploads/return-photo` and the returned URL is sent on the next chat request as `attachmentUrl`.

The visual system is driven from `/api/config`, including logo, colours, font family, radius, position, cart visibility, and track-order visibility. FAQ chips still come from `widget_settings.suggested_questions`.

## Decisions

The public widget source was kept in `public/js/widget.js` because the storefront already loads it directly. The external embed is intentionally a very small loader instead of another implementation, so a security or rendering fix only has one place to land.

The widget keeps no conversation history in localStorage or sessionStorage. Only the existing chat session id is persisted, as required by the customer identity design. Existing storefront cart persistence remains outside the widget source in `public/js/api.js`.

The brand API returns both a nested `brand` object and the same tokens at the top level. This preserves compatibility for existing callers while giving new embed code a single obvious configuration object.

Logo CSP support keeps the existing broad HTTPS image allowance and additionally includes the configured environment logo origin. Runtime database logo URLs are HTTPS and therefore covered by the same HTTPS image policy.

## Review fixes (applied after the first pass)

A review of the first steps 2 and 3 delivery found seven issues. All are fixed.

**Admin UI.** `admin.html` and `public/js/admin.js` now have Branding and Offers tabs. Branding edits every token, uploads a logo through the existing magic-byte checked upload route, and shows the value currently in effect in colour fields so an unset column does not look like black. Offers has create, activate, deactivate, and delete. The endpoints are no longer capability without access.

**URL scheme validation.** `zod.url()` accepts any valid URI scheme, so `javascript:alert(1)` and `data:text/html,...` were being stored and returned by `/api/config`. A `webUrl()` helper now pins every URL field to http or https: brand logos, product images, and return photos. Migration `012` adds matching CHECK constraints so a seed script or a psql session cannot write one behind the API's back, and clears any value already stored. `public/js/brand.js` and the widget both re-check before writing a URL into an attribute.

**Storefront branding.** `brand.js` wrote nine `--brand-*` variables but `css/main.css` only ever read `--brand-accent`, so a client-branded widget sat on an unchanged storefront. `brand.js` now also writes the names `main.css` actually consumes (`--ink`, `--muted`, `--white`, `--lavender`, `--border`, `--font-body`, the radius scale) and derives the accent shades from the client's accent with `color-mix`. One hex in the dashboard now restyles both.

**Duplicate embed.** `embed/velour-chat.js` and `public/embed/velour-chat.js` were byte identical and only the public one was ever served. The unserved copy is deleted.

**Offer bounds.** A PERCENT offer accepted 9000, and an end date before the start date was accepted, creating an offer that silently never activated. Both are rejected by schema and by CHECK constraint. Existing bad rows are repaired by migration `012` and deactivated rather than silently corrected, because clamping "9000% off" to "100% off" would turn a typo into a free order.

**Environment documentation.** `.env.example` documented three `BRAND_*` values while `env.js` defined fifteen. All are documented, marked as fallbacks that the dashboard overrides.

**Config failure handling.** A single failed `/api/config` request hid the widget permanently, so a brief restart looked like a broken site. The widget now retries three times with backoff and logs a clear console error if it still cannot load. It still refuses to render unbranded rather than showing another deployment's identity.

Also fixed: `test/brand-config.test.js` blanked only four of the fifteen brand columns before asserting environment fallback, so it passed on a fresh database and failed on one that had been used. It now snapshots and restores every column. The unused `BRAND_COLUMNS` constant in `src/routes/admin.js` is removed.

## Still open

Offers are still informational only. The Step 1 contract remains unchanged: the agent can read offers but cannot apply a discount, charge a different amount, refund, or cancel anything.

Cross-site customer verification still requires HTTPS in production because the customer session cookie is `SameSite=None; Secure`. Plain HTTP localhost is expected to fail for that particular browser cookie flow.

## Verification performed

JavaScript syntax checks passed for all modified Node and browser sources. `npm run test:offline` passed the existing agent-loop and provider fallback suites. The DB-backed `test/brand-config.test.js` is included in the normal test sequence and covers DB-over-env precedence, env fallback, merged config shape, malformed colours/URLs, and offer schema validation when a real `DATABASE_URL` is available.
