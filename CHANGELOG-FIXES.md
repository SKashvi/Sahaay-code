# Velour Production Fix Changelog

1. **Fix 1 — Zod schema boot failure** — `src/schemas/index.js`: reordered the `trackingUrl` chain so `.max(500)` runs before `.refine(...)`, avoiding the ZodEffects `.max()` TypeError.
2. **Fix 2 — Anthropic provider boot failure** — `src/lib/ai-providers/anthropic.js`, `src/lib/ai-providers/index.js`, `.env.example`: added the Anthropic Messages API provider, registered the factory, documented `anthropic` as a supported provider, and used a current overridable default model (`claude-sonnet-5`).
3. **Fix 3 — Refunds could bypass approval** — `src/lib/refunds.js`, `public/js/admin.js`, `test/refunds-and-webhooks.test.js`: refunds now require `APPROVED`; the dashboard only exposes the refund action for approved returns and shows explicit waiting/rejected states; added a regression assertion for SUBMITTED returns.
4. **Fix 4 — User-controlled email HTML** — `src/lib/notifications.js`: added server-side HTML escaping for the free-text customer name and shipment tracking carrier, number, and URL before interpolation into email HTML.
5. **Fix 5 — Upload MIME spoofing** — `src/routes/uploads.js`, `src/lib/storage.js`: added JPEG/PNG/WebP magic-byte detection and require the declared MIME type to match the actual file signature before upload.
6. **Fix 6 — JWT algorithm restriction** — `src/lib/auth.js`: explicitly signs with HS256 and verifies tokens with `algorithms: ['HS256']`.
7. **Fix 7 — Database SSL certificate validation** — `src/config/database.js`, `src/config/env.js`, `src/lib/db.js`, `db/migrate.js`, `db/seed.js`, `db/setup.js`, `.env.example`: centralized SSL configuration, defaulted `rejectUnauthorized` to true, and added the opt-in `DATABASE_SSL_INSECURE=true` escape hatch with an out-of-band verification warning.
8. **Fix 8 — Display-ID collision handling** — `src/lib/ids.js`, `src/routes/orders.js`: widened display IDs from 6 to 8 hex characters and added up to three INSERT attempts when the display-ID unique constraint collides, generating a fresh display ID and Razorpay order receipt each attempt.
9. **Fix 9 — Razorpay CSP breakage** — `src/app.js`: replaced bare Helmet CSP configuration with explicit Razorpay script/connect/frame directives and dynamically allows the configured S3 public origin for images.
10. **Fix 10 — Container root process / liveness** — `Dockerfile`: switches the application to the built-in `node` user and adds a `/healthz` Docker healthcheck.
11. **Fix 11 — Migration/seed/setup SSL parity** — `db/migrate.js`, `db/seed.js`, `db/setup.js`, `src/config/database.js`: all Postgres pools now use the same `DATABASE_SSL` / `DATABASE_SSL_INSECURE` configuration as the application pool.
12. **Fix 12 — Local Postgres credential warning** — `docker-compose.yml`: added the required local-development-only warning above the sample Postgres credentials.
13. **Fix 13 — Admin product editing** — `public/admin.html`, `public/js/admin.js`: added an image URL field, an edit workflow, prefilled existing product data, and PUT submission to the existing `/api/admin/products/:id` endpoint.
14. **Fix 14 — Brand token cleanup** — `public/js/brand.js`, `public/css/main.css`: removed the duplicated bootstrap comment and renamed the CSS custom properties/references from `--violet*` to brand-neutral `--brand-accent*` names.
15. **Fix 15 — Boot regression test** — `test/boot-test.js`, `package.json`: added a first-running boot test that requires the app and fails loudly on module-load errors, then wired it to run before the heavier suite.
16. **Fix 16 — CSP regression test** — `test/boot-test.js`: the boot test also requests `/checkout.html` and asserts that `script-src` explicitly contains `https://checkout.razorpay.com`.

## Verification record

- Node syntax checks for all modified CommonJS/JavaScript files: **PASSED**.
- Dependency-isolated probes for Anthropic provider construction/call, refund approval gating, email HTML escaping, image magic-byte detection, JWT HS256 restrictions, database SSL defaults, and 32-bit display IDs: **PASSED**.
- Current environment cannot execute the project's real integration suite because the required npm dependencies are absent and `npm ci` timed out; the environment also has no Docker or `psql` binary.
- Therefore the fresh-Postgres migration/seed run, full integration test suite, Docker image build, and live CSP HTTP-header verification remain **unexecuted here** and are not represented as passing.
