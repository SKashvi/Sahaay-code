# Step 1: agent core

The chat went from a text bot that had the catalog pasted into its prompt to
an agent that looks things up and can raise requests a human approves.

Nothing here touches the storefront, cart, checkout, payments, or the refund
engine. The widgets are unchanged in this step and still work, because
`/api/chat` still returns `reply` exactly as before, with `blocks` added
alongside it.

## Run it

```bash
npm install
npm run migrate      # applies 010_agent_core.sql
npm run seed         # needs ADMIN_EMAIL and ADMIN_PASSWORD set
npm run test:offline # loop and provider tests, no database or API key needed
npm test             # everything, needs DATABASE_URL
```

`.env` needs no new required values. `AI_VISION_PROVIDER` is optional and
unused until step 4.

## What the agent can do

| Tool | Needs verification | Effect |
|---|---|---|
| `search_catalog` | no | reads products and live stock |
| `get_store_policy` | no | reads the knowledge base |
| `check_offers` | no | reads active offers |
| `suggest_add_ons` | no | reads catalog neighbours for combos |
| `request_verification` | no | emails a six digit code |
| `get_order_status` | yes | reads the one verified order |
| `propose_return` | yes | writes a PENDING row |
| `propose_cancellation` | yes | writes a PENDING row |

No tool refunds, cancels, discounts, or charges anything. The two that write
create a `pending_actions` row and stop.

## How identity works

The chat session id lives in the browser's localStorage, so anyone can send
any session id they like. It groups messages and nothing else.

Identity is the signed httpOnly `customer_session` cookie, which carries the
session id it was issued for and the single order id it authorises.
`customerForSession()` hands back an identity only when the cookie's session
id matches the one on the request, so pasting someone else's session id gets
you nothing.

The code itself never reaches the model. The agent can ask for one to be
sent, but the customer types it into the widget's own field, which posts
straight to `/api/session/verify`. A prompt injection cannot talk its way
into a verified session because the verification path is not reachable from
a tool call.

Other rules that hold at the boundary:

- Requesting a code answers identically whether or not the order exists, so
  this is not an order id checker.
- Codes are stored bcrypt hashed, single use, ten minute expiry, five
  attempts, and a new code kills the previous one.
- Photo URLs are checked against this server's own upload host before the
  agent or any tool sees them.
- Eligibility is re-checked at approval time, not trusted from when the
  agent proposed it. Days pass in between and return windows close.
- Refund amounts are always recomputed from the order's real recorded
  prices. Whatever the agent estimated is ignored.

## Approving a request

```
GET  /api/admin/pending-actions?status=PENDING
POST /api/admin/pending-actions/:id/approve   { note }
POST /api/admin/pending-actions/:id/reject    { note }
```

Approving a RETURN creates the `return_requests` row in APPROVED status
through the same `resolveReturnItems` path the customer-facing form uses. It
does not move money. The refund still runs through
`POST /api/admin/returns/:id/refund`, so Razorpay is only ever touched by a
separate explicit click.

Approving a CANCELLATION goes through `transitionOrder`, so an invalid
transition is refused exactly as it would be from the dashboard.

## Provider layer

All five providers now return `{ text, toolCalls }`.

OpenAI, DeepSeek, Gemini, and Groq share `openaiCompatible.js`. Anthropic
maps its own format, including the part that is easy to get wrong: several
tool results from one assistant turn must merge into a single user message
with several `tool_result` blocks, not one message each. Covered by
`test/agent-loop.test.js`.

For step 4, note that Groq's `gpt-oss-20b` and every DeepSeek model have no
image input, so photo scoring needs `AI_VISION_PROVIDER` set to gemini,
openai, or anthropic.

## Fixed along the way

- `promptCache` was declared and read but never written, so the cache never
  filled and the prompt was rebuilt on every message. It is now populated,
  with a sixty second TTL.
- The catalog and knowledge base no longer go into every prompt, so prompt
  cost stops growing with the catalog and stock is read when it is quoted.
- `.env.example` claimed the default provider was deepseek while setting
  gemini with a Groq model name, listed the provider options twice, and
  defined `DEFAULT_VARIANT_STOCK` twice.
- `AI_TIMEOUT_MS` raised from 5s to 30s. A tool loop makes several calls and
  five seconds cuts them off mid-conversation.

## Still open, by design

- Widgets do not render `blocks` yet. That is step 3, along with the shadow
  DOM stylesheet bug in the embed and merging the two widgets into one.
- `brand_config` is not built yet, branding is still the three env vars.
  That is step 2.
- `offers` has a table and a tool but is not applied at checkout. Checkout
  still charges what the products table says. Wiring offers into pricing is
  a separate, deliberate change.
- No admin UI for pending actions yet, the endpoints exist and are tested.
