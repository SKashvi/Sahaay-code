# Velour, an AI shopping assistant storefront

A real, deployable storefront with an AI chat widget: product catalog,
cart, checkout with Razorpay, order tracking, and a return/refund/damaged
goods flow with photo upload, plus an admin dashboard. One Node.js process
serves both the API and the frontend, backed by a real Postgres database.
No hardcoded brand name, colors, or catalog, everything is configuration.

## Requirements
- Node.js 20 or newer
- A Postgres database (local, or any managed provider)
- A Razorpay account (test mode is fine to start)
- An Anthropic API key
- An S3-compatible bucket for return photos (AWS S3, Cloudflare R2,
  Backblaze B2, DigitalOcean Spaces, or a local MinIO for development)

## Setup
```
npm install
cp .env.example .env
```
Fill in every value in `.env`, see the comments in that file for where each
one comes from.

```
npm run setup
```
One guided pass that checks your Node version, confirms every required
variable is set, tests real connectivity to the database, Razorpay, your
AI provider, and S3, then runs migrations and creates your first admin
login (from ADMIN_EMAIL / ADMIN_PASSWORD in `.env`). It prints a clear
pass, fail, or warning line for each check, fix anything marked FAIL and
run it again, it is safe to re-run.

```
npm start
```
Visit `http://localhost:4000`. Sign in to the admin dashboard at
`/admin.html`.

Prefer the old manual steps? `npm run migrate` and `npm run seed` still
work exactly as before, `npm run setup` just wraps them with the
connectivity checks.

### With Docker instead
```
cp .env.example .env   # fill it in first
docker compose up --build
```
This also starts a local Postgres for you, so DATABASE_URL in your .env is
overridden to point at it automatically, everything else in .env still
applies.

## Relabeling this for a client or another buyer
Every part of the brand lives in three environment variables:
`BRAND_NAME`, `BRAND_ACCENT`, `BRAND_TAGLINE`. Change those, restart the
server, done, no code or HTML to touch. The frontend fetches these from
`/api/config` on load and applies them to the logo, page titles, and the
Razorpay checkout modal.

The product catalog, knowledge base (what the AI assistant is grounded on),
orders, and returns are all managed from `/admin.html`, not by editing
files.

## What is real versus what you are plugging in
Real, working code: the full checkout and payment flow with race-safe
inventory, real Razorpay refunds, item-level returns with eligibility
rules, order tracking, the admin dashboard, transactional email, and the
chat widget backed by a real AI provider call (deepseek by default, with openai, anthropic, gemini, or groq also supported) grounded in your knowledge base and
catalog (see `src/lib/ai.js` and `src/lib/ai-providers`).

What you provide: the database, your Razorpay account, an API key for
whichever AI provider you pick, your object storage bucket, optionally an
email provider, and your actual product catalog (add products and set
real stock from the admin dashboard, or write a small import script
against `POST /api/admin/products`, whichever is easier for how many you
have).

There is no function calling / tool use in the chat, meaning the assistant
answers questions grounded in your catalog and knowledge base but cannot
place an order, apply a discount, or start a return on its own, those
still happen through the site's normal cart, checkout, and order tracking
flows. That is a deliberate scope line, not an oversight, see
`src/lib/ai.js` for where it is enforced.

## Testing your own deployment
```
npm test
```
Runs the full test suite (checkout and payment flow, real refunds, webhook
deduping, order tracking, returns, admin auth, and the chat-history
regression test) against your configured database. Razorpay calls are
mocked inside these scripts so none of it needs live payment credentials
or touches your real Razorpay account. Read `SECURITY-CHECKLIST.md` before
taking real payments.

## Project layout
```
src/
  app.js            Express app, middleware, and route mounting
  server.js         entry point
  config/env.js     loads and validates every environment variable
  lib/
    db.js, auth.js, razorpay.js, storage.js, ids.js
    ai.js               builds the prompt, calls ai-providers, logs history
    ai-providers/       provider-agnostic AI client (deepseek default,
                        openai and anthropic also supported, plus an
                        optional fallback provider)
    email.js            provider-agnostic email sending (resend, or
                        console for local dev), never throws
    notifications.js    the actual order/return/refund email templates
    orderStateMachine.js  validated order status transitions only
    returns.js          return eligibility rules and item-level validation
    refunds.js           concurrency-safe refund claiming
  middleware/       admin auth, rate limits, validation, error handling
  routes/           one file per resource: products, orders, payments,
                    returns, uploads, chat, admin, config
  schemas/          zod validation for every request body
db/
  migrations/       numbered, tracked SQL migrations, applied in order
  migrate.js        applies any migration not yet recorded as run, safe to
                    run repeatedly and against a database with real data
  setup.js          guided setup: validates everything, then migrates and
                    seeds, see `npm run setup`
  seed.js           creates the first admin user and a starter catalog
                    (with starter product variants and stock)
public/             the frontend: plain HTML/CSS/JS, no build step
test/
  smoke-test.js                 checkout, payment, tracking, item-level
                                 returns, order lifecycle, admin
  refunds-and-webhooks.test.js  real refund flow and webhook dedupe
  refund-concurrency.test.js    two simultaneous refunds, only one gateway call
  webhook-transaction.test.js   a failed webhook update rolls back cleanly
  inventory-concurrency.test.js two simultaneous purchases of the last unit
  ai-memory.test.js             regression test for the chat-history window
  ai-provider-fallback.test.js  timeout/rate-limit/error fallback behavior
```

## Deploying
This is a single Node process with no build step, it runs anywhere that
runs Node: Railway, Render, Fly.io, a plain VPS, or the included
`Dockerfile` on any container host. Point `DATABASE_URL` at a real Postgres
instance, set every other variable in `.env.example`, and run
`node db/migrate.js && node src/server.js` (the Dockerfile already does
this on container start).


### Razorpay webhook events
Configure the webhook for `payment.captured`, `payment.failed`, and `order.paid`. The app verifies the raw webhook signature and deduplicates using Razorpay's `x-razorpay-event-id` header when available.


## Standalone website embed

The customer-facing embed lives in `embed/`. It renders only the chat interface on a client website; storefront/cart/checkout/admin pages are not required by the visitor. See `embed/INSTALL.md` for the exact script tag and CORS setup.

The admin dashboard remains available at `/admin.html` for catalog, inventory, knowledge-base, and widget-question management.
