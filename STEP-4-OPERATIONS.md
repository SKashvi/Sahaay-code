# Step 4 and operations

This is the last planned batch. Seven things, in the order they were built.

## Run it

```bash
npm install
npm run migrate          # applies 013_operations.sql
npm run seed             # needs ADMIN_EMAIL and ADMIN_PASSWORD
npm run test:offline     # no database, no API key
npm test                 # everything, needs DATABASE_URL
```

No new required environment values. `AI_VISION_*` is optional and photo
scoring stays off until it is set.

## 1. Requests screen

The pending-actions endpoints existed and were tested since step 1, but there
was no way to use them without an API client. There is now a Requests tab
showing what the assistant asked for, the items and reason, its note to the
reviewer, the photo, and the photo score when scoring is on. Approve and
reject are one click each.

Approving a return still does not send money. It creates the return in
approved status, and the refund remains a separate click on the Returns tab
that calls Razorpay. That separation is the point of the whole design and it
is unchanged.

## 2. Conversations

`chat_messages` had been written since the first version and nothing ever
read it, so "the assistant said something wrong yesterday" was unanswerable.
There is now a Conversations tab: sessions newest first, with the verified
customer and order where there is one, and a transcript reader.

Blocks are summarised rather than re-rendered. This is a view for reading
what was said, not a second copy of the widget that has to be kept in step
with the first.

## 3. Error log

New `error_log` table, read on a Diagnostics tab. It records server faults
and assistant failures, not general request traffic, because the question it
exists to answer is "why did the assistant do that", not "what requests came
in".

Two deliberate limits. Only 5xx responses are recorded: a 400 from a bad
request body is the validation layer working, and logging those would bury
real failures under mistyped forms. And the context field uses an allowlist,
not a filter, so a field added somewhere else in the codebase cannot leak
into a table a human reads in a dashboard. Request bodies are never passed
in at all. Rows older than 30 days are pruned when the list is opened, so
there is no scheduled job to deploy or forget.

## 4. Offers that change the price

This was the gap worth the most money. The assistant could read an offer and
name a code, and checkout charged full price anyway, so the assistant was
making a promise the checkout did not keep.

Checkout now accepts an `offerCode` and nothing else. The discount is looked
up and computed in `src/lib/offers.js` from the offers table. A request that
posts its own `discount` or `total` changes nothing, which is covered by a
test that sends `discount: 999999` and asserts the total is unmoved.

Rules that are enforced rather than assumed:

- a flat offer larger than the cart is capped at the subtotal, so a total can
  never go negative
- a product-scoped offer only discounts the lines it names, so "20% off
  jackets" cannot quietly become 20% off the cart
- a minimum spend is checked server side
- an unusable code is reported as an error rather than silently ignored,
  because a customer who typed one and was charged full price has no way to
  tell what happened

**Refunds are prorated.** A discount belongs to the order, not to a line, so
refunding an item at its recorded price would hand back more than was ever
charged. Checkout stores a `refund_ratio` on the order and
`resolveReturnItems` multiplies by it. The ratio is read from the order, not
recomputed from the offers table, so editing or deleting an offer later
cannot change what an old order refunds. A full return on a 25% discounted
order refunds exactly what was paid for the goods, which the test asserts
against the stored subtotal minus discount.

The offer code is also part of the checkout fingerprint now. Without that, a
retried idempotency key that added a code would silently replay the order
created at the old price.

## 5. Vision scoring on return photos

A photo attached to a return is scored against the stated reason, and the
score, verdict and one-line reasoning appear on the Requests screen.

The score is advice. Nothing in the codebase reads `ai_verdict` to approve,
reject or refund anything, and a human still clicks approve.

Configured separately from chat, because the cheap text models cannot see:
Groq's `gpt-oss-20b` and every DeepSeek model have no image input. Only
gemini, openai and anthropic are accepted as `AI_VISION_PROVIDER`, and the
test asserts that groq and deepseek are refused rather than failing on every
photo at runtime. Leaving it blank turns scoring off, which is a supported
configuration.

Two safety properties: only URLs this server issued are ever fetched, so the
scorer cannot be pointed at an internal address, and an unparseable model
answer produces no score rather than a guessed one. Scoring runs in the
background so a slow vision call never delays or fails a customer's return.

## 6. Operator and client roles

`admin_users.role` is now `operator` or `client`. An operator is the agency,
a client is the store owner. Existing accounts become operators on upgrade so
nobody is locked out of their own dashboard.

A client runs their shop: products, inventory, orders, returns, requests,
branding, offers, bundles, conversations. An operator additionally gets
Diagnostics and Team, and is the only role that can create accounts.

Deliberately two roles rather than a permissions table, because two roles fit
in a person's head and a flexible scheme nobody audits does not. The UI hides
the operator tabs, but that is convenience: the endpoints check the role
server side and return 403 regardless of what the browser displays, which the
tests assert directly. An operator cannot remove their own account or the
last remaining operator, because either would lock everyone out of the
operator-only surfaces with no way back.

## 7. Bundles

`suggest_add_ons` used to return the three cheapest in-stock products, which
is a catalog neighbour, not a combo. There is now a `bundles` table and a
Bundles tab where a human groups products deliberately.

The tool prefers a real bundle and tells the model which it is getting: a
`source` of `curated_bundle` means these were grouped on purpose and may be
presented as a set, `catalog_neighbours` means they are simply other products
and should be offered loosely. The agent no longer presents a guess as a
considered recommendation.

## Still open

**Offers are not stacked.** One code per order. Two offers that would both
apply is a policy question, not a bug, and combining them silently is how
stores end up giving away more than they meant to.

**Bundles do not price.** A bundle groups products for suggestions. A bundle
that is also a discount should be an offer with `product_ids` set.

**Multi-client operations.** Each client is still a separate deployment.
Migrating and health-checking several by hand is fine at one or two and
tedious by five. A script that runs migrations across every deployment and a
single place to see their readiness probes is the next real piece of work,
and it is ops tooling rather than product.

**Role is read from the token.** A demotion takes effect at the next sign-in
rather than immediately, bounded by the 8 hour token lifetime. Checking the
database on every request would close that window at the cost of a query per
request, which is not worth it at this scale but is the thing to change if it
ever is.
