# Security checklist before this goes live with real customers and real money

## What is already built in
- Every database query in this codebase is parameterized (see src/lib/db.js
  and every file under src/routes), there is no string concatenation of
  request input into SQL anywhere. Verified with an actual injection-shaped
  payload in test/smoke-test.js.
- Every price charged is recalculated server side from the database at
  checkout, the client cannot influence what gets charged. Verified in
  test/smoke-test.js.
- Every payment is confirmed via a verified HMAC signature (both the
  browser-side confirmation and the Razorpay webhook), never trusted from
  the client alone.
- Every place user-typed or user-submitted text gets shown on a page (chat
  messages, names, sizes, colors, admin dashboard tables) is passed through
  escapeHtml() before it touches innerHTML, so injected HTML/script renders
  as inert text instead of executing.
- Admin passwords are hashed with bcrypt (12 rounds), sessions are signed
  JWTs in an HttpOnly cookie, and the login endpoint takes the same time to
  respond whether or not the email exists, to resist timing based user
  enumeration.
- Sensitive endpoints (admin login, order tracking, returns, chat, uploads)
  are all rate limited.
- File uploads are checked against an allowed list of image types and a
  size limit twice, once at the upload layer and again before the bytes are
  sent to storage.
- The server refuses to start at all if any required secret is missing from
  the environment, rather than running in some silently half configured
  state.
- Security headers (via helmet), a strict CORS origin, and a request body
  size limit are all on by default.
- Double-submitted or retried checkouts cannot create two orders (an
  idempotency key, checked and race-tested with real concurrent requests,
  see test/smoke-test.js), and a Razorpay webhook delivered more than once
  (their own docs say to expect this) is only ever acted on once (see
  test/refunds-and-webhooks.test.js).
- Marking a return "REFUNDED" now requires a real, successful Razorpay
  refund call, it cannot be set by hand, and a failed refund attempt is
  recorded as an error without ever falsely marking the return refunded.
  Verified against both a successful and a failing mock refund.
- A return's photo must be a URL this server generated itself via the
  upload endpoint, an arbitrary external URL is rejected.
- /readiness checks real database connectivity, separate from /healthz
  (a plain liveness check), so an orchestrator or load balancer can tell
  the difference between "the process is up" and "it can actually serve a
  request right now."
- The database schema is applied through tracked, numbered migrations
  (db/migrations/, run via `npm run migrate`), not a single script that
  would need hand-editing to evolve safely against a live database with
  real orders in it.

## Known, deliberate gaps, not yet built
- No role-based admin access, every admin login can do everything.
- No inventory or stock tracking, checkout does not check or reserve stock.
- No transactional email (order confirmation, shipment, refund notices).
- The AI provider is Anthropic only, no fallback provider yet.
None of these are security holes exactly, they are scope not yet covered,
listed here so they are a decision, not a surprise.

## Second hardening pass: money-safety and business-logic fixes
- **Checkout idempotency now detects key reuse.** The same idempotency key
  replayed with the same cart returns the original order (safe retry). The
  same key reused with a genuinely different cart or customer is rejected
  with a 409, it no longer silently hands back the wrong order for the
  wrong request. Verified in test/smoke-test.js.
- **Webhook processing is now a single atomic transaction.** The dedupe
  claim and the order status update either both commit or both roll back.
  A prior version did these as two separate queries, if the update ever
  threw after the dedupe row committed, a legitimate Razorpay retry would
  be permanently swallowed as "already processed" and the payment
  confirmation would be lost. Fixed and covered by a dedicated test that
  forces the failure through the real route:
  test/webhook-transaction.test.js.
- **Refunds are now concurrency-safe.** A row lock (`SELECT ... FOR UPDATE`)
  claims a return into a REFUND_PENDING state before Razorpay is ever
  called. Two truly simultaneous refund requests for the same return can
  no longer both reach Razorpay, only one gets the refund, the other gets
  a 409. This was not previously true, a sequential "call it twice" test
  had passed and did not catch it, a real concurrent test does:
  test/refund-concurrency.test.js.
- **Returns are now item-level, not order-level.** A return names exactly
  which order items and quantities are being returned, and the refund
  amount is computed server side from those specific items, never from
  the order's full total. Returning one item out of a multi-item order no
  longer refunds the whole order.
- **Return eligibility is enforced.** An order must actually be paid and
  marked DELIVERED, and within a configurable return window
  (`RETURN_WINDOW_DAYS`, default 14 days from delivery), before a return
  can be submitted against it at all. Previously any order was accepted
  purely on an email and order ID match, regardless of its actual status.
- **Order status changes now go through a real state machine.** An admin
  can no longer jump an order directly from, say, DELIVERED back to
  PENDING_PAYMENT. Valid transitions are centralized in
  src/lib/orderStateMachine.js, and shipped_at / delivered_at /
  cancelled_at are stamped automatically as part of the same transition,
  never set independently of the status they describe.
- **The checkout page now shows the real total.** It previously displayed
  the cart subtotal labeled "Total," shipping never appeared even though
  it was being charged. Subtotal, shipping, and total are now all shown,
  computed from the same shipping settings (`SHIPPING_FREE_THRESHOLD`,
  `SHIPPING_FLAT_FEE`) the backend actually uses for the real charge,
  fetched from the same `/api/config` endpoint rather than hardcoded
  separately in two places.
- **Cart color is now validated the same way size already was.** A
  request for a color the product does not actually offer is rejected,
  instead of being accepted and stored as-is.

## What you (or whoever deploys this) still needs to check
These are things no codebase can guarantee on its own, they depend on how
it is actually deployed and operated:

- [ ] Put a real, unique JWT_SECRET in production, generated with
      `openssl rand -hex 32`, never the placeholder from .env.example.
- [ ] Confirm the server is only reachable over HTTPS in production (this
      app expects TLS termination at your host or reverse proxy, it does
      not terminate TLS itself).
- [ ] Confirm your Postgres provider's database is not publicly reachable
      from the open internet, only from your app server.
- [ ] Rotate the admin password from whatever was set during `npm run seed`
      if more than one person had access to that value.
- [ ] Set up the Razorpay webhook in their dashboard pointing at
      /api/payments/razorpay/webhook, and confirm RAZORPAY_WEBHOOK_SECRET
      matches what Razorpay shows you there, not a made up value.
- [ ] Confirm your S3 bucket (or equivalent) does not allow public listing
      of its contents, only reading of individual uploaded files by URL.
- [ ] Set a real, restrictive CORS_ORIGIN if the frontend is ever hosted on
      a different domain than this API.
- [ ] Get an independent security review or penetration test before taking
      real customer payments at any meaningful volume. This checklist and
      the automated tests in test/smoke-test.js are a solid baseline, they
      are not a substitute for a second set of eyes that were not the ones
      who wrote the code.
- [ ] Keep dependencies updated (`npm audit`), a codebase that was clean at
      launch is not automatically clean a year later.

## If you are reselling this to another agency
Give them this file along with the code. Whether their deployment is safe
is now a function of how they configure and host it, not just the code
itself, and that is worth being upfront about in whatever agreement you
use to sell it to them.

## Third pass: inventory, AI provider abstraction, transactional email
- **Stock is now real and race-safe.** Every size/color combination is its
  own variant with its own stock count. Checkout decrements stock with a
  single conditional UPDATE (the stock check and the decrement are one
  atomic operation under Postgres's row lock), so two concurrent
  purchases of the final unit cannot both succeed. Proven with a genuine
  concurrent test, not a sequential one: test/inventory-concurrency.test.js.
- **No hard dependency on Anthropic anymore.** AI_PROVIDER picks deepseek
  (default), openai, or anthropic, see src/lib/ai-providers. An optional
  fallback provider is used only for genuinely retryable failures
  (timeout, rate limit, upstream 5xx), never for a bad API key or a real
  400, that would hide a configuration mistake instead of surfacing it.
  Tested against the real shipped module with mocked provider factories,
  see test/ai-provider-fallback.test.js.
- **Transactional email is real, not a placeholder.** Order confirmed,
  shipped, delivered, return submitted, return approved/rejected, and
  refund completed all send an actual email when EMAIL_PROVIDER is
  configured. A broken email provider is caught and logged, it can never
  turn a successful payment, refund, or status change into an error
  response. Email is optional: leaving EMAIL_PROVIDER unset skips sending
  cleanly, nothing else in the app depends on it.
- **`npm run setup`** validates the runtime, every required environment
  variable, and live connectivity to the database, Razorpay, the AI
  provider, and S3, before running migrations and creating the first
  admin. Prints a clear pass/fail/warn line for each check.

## Known, deliberate gaps, still not built
- No role-based admin access, every admin login can do everything.
- No automated restock on order cancellation or a processed return, stock
  adjustments after the fact are a manual action from the Inventory tab.
- The AI assistant is read-only (answers questions, cannot place an order,
  apply a discount, or start a return on its own), on purpose, per the
  scope this build was built to.
None of these are security holes, they are scope not yet covered, listed
here so they are a decision, not a surprise.
