/* The agent's tools.
 *
 * Two hard rules hold across every tool in this file:
 *
 *   1. No tool writes money or order state. The three that change anything
 *      write a PENDING row into pending_actions and stop. An admin approving
 *      that row is what creates a return or cancels an order, through the
 *      same code paths the dashboard already uses.
 *   2. No tool reads customer data from arguments the model supplies. Order
 *      access comes from ctx.customer, which is set from a signed httpOnly
 *      cookie, never from anything the model or the browser can assert. A
 *      model that hallucinates an order id gets nothing.
 *
 * Each executor returns { result, blocks }:
 *   result  goes back to the model as the tool result, compact JSON
 *   blocks  goes to the widget to render, and is never seen by the model
 */

const db = require('../db');
const { newId, newDisplayId, paiseToRupeeString } = require('../ids');
const { checkOrderEligibility, resolveReturnItems, ReturnEligibilityError, RETURN_WINDOW_DAYS } = require('../returns');
const { isOwnUploadUrl } = require('../storage');
const { requestCode } = require('./verification');
const { scoreInBackground } = require('./photoScoring');

const NEEDS_VERIFICATION = {
  error: 'not_verified',
  message: 'This needs a verified customer. Ask for the email used at checkout and the order ID, then call request_verification.',
};

/* ------------------------------------------------------------------ */
/* Definitions                                                         */
/* ------------------------------------------------------------------ */

const definitions = [
  {
    name: 'search_catalog',
    description:
      'Search the live product catalog. Use this for any question about what is available, sizing, price, fabric, or stock. Never describe a product from memory, always search first. Return the fewest products that answer the question. Use 1 when the customer has described what they want.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free text, e.g. "cotton kurta" or "under 2000".' },
        maxPrice: { type: 'integer', description: 'Maximum price in rupees, not paise.' },
        size: { type: 'string', description: 'Filter to products with this size in stock.' },
        limit: { type: 'integer', description: 'How many products to return, 1 to 6. Default 2.' },
      },
      required: [],
    },
  },
  {
    name: 'get_store_policy',
    description:
      'Look up the store knowledge base for shipping, returns, exchanges, care, payment, or any other policy question. Use this instead of guessing a policy.',
    parameters: {
      type: 'object',
      properties: { topic: { type: 'string', description: 'What the customer is asking about, e.g. "return window" or "cash on delivery".' } },
      required: ['topic'],
    },
  },
  {
    name: 'check_offers',
    description:
      'List offers that are active right now. Only mention an offer that comes back from this tool. Never invent a discount code.',
    parameters: {
      type: 'object',
      properties: { subtotal: { type: 'integer', description: 'Cart subtotal in rupees, if known, so offers with a minimum spend can be filtered.' } },
      required: [],
    },
  },
  {
    name: 'suggest_add_ons',
    description:
      'Given a product the customer is interested in, get other in-stock products worth suggesting alongside it. Use this for combos and upsells. Check the "source" field in the result: "curated_bundle" means the store deliberately grouped these and you may present them as a set, "catalog_neighbours" means they are simply other products and you should present them as a loose suggestion.',
    parameters: {
      type: 'object',
      properties: { productId: { type: 'string', description: 'The id returned by search_catalog.' } },
      required: ['productId'],
    },
  },
  {
    name: 'request_verification',
    description:
      'Send a six digit code to the email on an order. Call this before any order specific help when the customer is not verified yet. You need both the email used at checkout and the order ID. The customer types the code into the widget, not into the chat, so never ask them for the code and never call this with a code.',
    parameters: {
      type: 'object',
      properties: {
        email: { type: 'string', description: 'Email the customer used at checkout.' },
        orderId: { type: 'string', description: 'Order ID, e.g. VEL-4F92A1C8.' },
      },
      required: ['email', 'orderId'],
    },
  },
  {
    name: 'get_order_status',
    description:
      'Get the verified customer\'s order: status, items, tracking, and whether it is still inside the return window. Takes no arguments, it always reads the order this session is verified against.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'propose_return',
    description:
      'Submit a return or refund request for review. This does NOT approve anything and does NOT move money, a human reviews it in the dashboard. Tell the customer it has been sent for review, never that it is approved or that a refund is on the way. If the reason is a damaged or wrong item, ask for a photo first and pass its URL.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Which items to return. Use the itemId values from get_order_status.',
          items: {
            type: 'object',
            properties: {
              itemId: { type: 'string' },
              quantity: { type: 'integer' },
            },
            required: ['itemId', 'quantity'],
          },
        },
        reason: { type: 'string', enum: ['Wrong size', 'Damaged item', 'Not as described', 'Changed my mind'] },
        description: { type: 'string', description: 'What the customer said, in their words.' },
        photoUrl: { type: 'string', description: 'URL returned when the customer uploaded a photo in this chat.' },
        reasoning: { type: 'string', description: 'One line for the human reviewer on why this looks legitimate or needs a closer look.' },
      },
      required: ['items', 'reason'],
    },
  },
  {
    name: 'propose_cancellation',
    description:
      'Submit a cancellation request for review. Only works before an order ships. Same rule as propose_return, this is a request, not a cancellation. Never tell the customer the order is cancelled.',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the customer wants to cancel.' },
        reasoning: { type: 'string', description: 'One line for the human reviewer.' },
      },
      required: ['reason'],
    },
  },
];

/* ------------------------------------------------------------------ */
/* Executors                                                           */
/* ------------------------------------------------------------------ */

/* One shape for every product a tool puts in a products block.
 *
 * src/routes/orders.js resolves a line to a variant with the composite key
 * productId::size::color, and rejects the checkout when no variant matches.
 * A block that omits sizesInStock or colorsInStock therefore produces a cart
 * line that cannot be bought, so both search_catalog and suggest_add_ons map
 * their rows through here rather than each assembling their own object.
 *
 * Sizes and colours are aggregated independently, so a card can list a size
 * and a colour whose specific pairing is sold out. Checkout is the authority
 * on that and rejects the line by name, which is the same position the
 * storefront product page is in.
 */
function toProductCard(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    price: paiseToRupeeString(row.price),
    pricePaise: row.price,
    fabric: row.fabric || undefined,
    imageUrl: row.imageUrl || undefined,
    inStock: Number(row.available) > 0,
    sizesInStock: row.sizesInStock || [],
    colorsInStock: row.colorsInStock || [],
  };
}

/* The same card minus the two fields only the browser needs. Keeping them out
 * of the tool result saves tokens and stops the model quoting a raw paise
 * integer at a customer. */
function toProductResult(card) {
  const { imageUrl, pricePaise, ...rest } = card;
  return rest;
}

function clampLimit(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), 1), max);
}

async function searchCatalog(args) {
  const limit = clampLimit(args.limit, 2, 6);
  const query = String(args.query || '').trim();
  const maxPricePaise = Number.isFinite(Number(args.maxPrice)) && Number(args.maxPrice) > 0
    ? Math.round(Number(args.maxPrice) * 100)
    : null;
  const size = String(args.size || '').trim();

  // Available stock is real stock minus what pending checkouts are holding,
  // so the agent never offers something a reservation has already claimed.
  const result = await db.query(
    `SELECT p.id, p.name, p.slug, p.price, p.fabric, p.image_url AS "imageUrl", p.sizes,
            COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0)::int AS available,
            COALESCE(array_agg(DISTINCT v.size) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "sizesInStock",
            COALESCE(array_agg(DISTINCT v.color) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "colorsInStock"
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active = true
      WHERE p.active = true
        AND ($1 = '' OR p.name ILIKE '%' || $1 || '%' OR COALESCE(p.fabric, '') ILIKE '%' || $1 || '%')
        AND ($2::int IS NULL OR p.price <= $2::int)
        AND ($3 = '' OR $3 = ANY (p.sizes))
      GROUP BY p.id
      ORDER BY (COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0) > 0) DESC, p.price ASC
      LIMIT $4`,
    [query, maxPricePaise, size, limit]
  );

  const products = result.rows.map(toProductCard);

  return {
    result: { count: products.length, products: products.map(toProductResult) },
    blocks: products.length ? [{ type: 'products', items: products }] : [],
  };
}

async function getStorePolicy(args) {
  const topic = String(args.topic || '').trim();
  const result = await db.query(
    `SELECT topic, content FROM knowledge_base_entries
      WHERE active = true
        AND ($1 = '' OR topic ILIKE '%' || $1 || '%' OR content ILIKE '%' || $1 || '%')
      ORDER BY topic ASC
      LIMIT 5`,
    [topic]
  );
  if (!result.rows.length) {
    // A miss must read as a miss, not as permission to improvise.
    return {
      result: { found: false, note: 'Nothing in the knowledge base covers this. Say you are not sure and offer to pass it to the team.' },
      blocks: [],
    };
  }
  return { result: { found: true, entries: result.rows }, blocks: [] };
}

async function checkOffers(args) {
  const subtotalPaise = Number.isFinite(Number(args.subtotal)) ? Math.round(Number(args.subtotal) * 100) : null;
  const result = await db.query(
    `SELECT code, title, description, kind, value, min_subtotal AS "minSubtotal"
       FROM offers
      WHERE active = true
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())
        AND ($1::int IS NULL OR min_subtotal <= $1::int)
      ORDER BY min_subtotal ASC
      LIMIT 6`,
    [subtotalPaise]
  );
  const offers = result.rows.map((row) => ({
    code: row.code || undefined,
    title: row.title,
    description: row.description,
    kind: row.kind,
    value: row.value,
    minSpend: row.minSubtotal ? paiseToRupeeString(row.minSubtotal) : undefined,
  }));
  return {
    result: { count: offers.length, offers },
    blocks: offers.length ? [{ type: 'offers', items: offers }] : [],
  };
}

async function suggestAddOns(args) {
  const productId = String(args.productId || '');
  if (!/^[0-9a-f-]{36}$/i.test(productId)) {
    return { result: { error: 'invalid_product_id', message: 'Call search_catalog first and use an id from its result.' }, blocks: [] };
  }

  // A curated bundle is a pairing a human chose, so it is offered first and
  // labelled as such. Only if no bundle covers this product does the tool
  // fall back to catalog neighbours, and the result says which kind it is so
  // the agent does not present a guess as a considered recommendation.
  const bundled = await db.query(
    `SELECT b.title AS "bundleTitle", b.description AS "bundleDescription",
            p.id, p.name, p.slug, p.price, p.fabric, p.image_url AS "imageUrl",
            COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0)::int AS available,
            COALESCE(array_agg(DISTINCT v.size) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "sizesInStock",
            COALESCE(array_agg(DISTINCT v.color) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "colorsInStock"
       FROM bundles b
       JOIN products p ON p.id = ANY(b.product_ids) AND p.id <> $1 AND p.active = true
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active = true
      WHERE b.active = true AND $1 = ANY(b.product_ids)
      GROUP BY b.title, b.description, p.id
     HAVING COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0) > 0
      ORDER BY p.price ASC
      LIMIT 3`,
    [productId]
  );

  if (bundled.rows.length) {
    const products = bundled.rows.map(toProductCard);
    return {
      result: {
        source: 'curated_bundle',
        bundleTitle: bundled.rows[0].bundleTitle,
        note: 'These are a bundle the store put together deliberately. It is fine to present them as a set.',
        count: products.length,
        products: products.map(toProductResult),
      },
      blocks: [{ type: 'products', items: products, heading: bundled.rows[0].bundleTitle }],
    };
  }

  const result = await db.query(
    `SELECT p.id, p.name, p.slug, p.price, p.fabric, p.image_url AS "imageUrl",
            COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0)::int AS available,
            COALESCE(array_agg(DISTINCT v.size) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "sizesInStock",
            COALESCE(array_agg(DISTINCT v.color) FILTER (
              WHERE v.active AND (v.stock_quantity - v.reserved_quantity) > 0
            ), '{}') AS "colorsInStock"
       FROM products p
       LEFT JOIN product_variants v ON v.product_id = p.id AND v.active = true
      WHERE p.active = true AND p.id <> $1
      GROUP BY p.id
     HAVING COALESCE(SUM(GREATEST(v.stock_quantity - v.reserved_quantity, 0)), 0) > 0
      ORDER BY p.price ASC
      LIMIT 3`,
    [productId]
  );
  const products = result.rows.map(toProductCard);
  return {
    result: {
      source: 'catalog_neighbours',
      note: 'No curated bundle covers this product, so these are simply other in-stock items. Present them as "you might also like", not as a matched set.',
      count: products.length,
      products: products.map(toProductResult),
    },
    blocks: products.length ? [{ type: 'products', items: products, heading: 'You might also like' }] : [],
  };
}

async function requestVerification(args, ctx) {
  const email = String(args.email || '').trim();
  const orderId = String(args.orderId || '').trim();
  if (!email || !orderId) {
    return { result: { error: 'missing_details', message: 'Ask for both the checkout email and the order ID.' }, blocks: [] };
  }

  await requestCode({ sessionId: ctx.sessionId, email, displayId: orderId });

  // Deliberately the same answer whether or not the order matched. The model
  // is not told, so it cannot leak it, and the widget shows a code field
  // either way.
  return {
    result: {
      sent: true,
      message: 'If those details match an order, a six digit code is on its way to that email. Tell the customer to enter it in the box shown, not in the chat.',
    },
    blocks: [{ type: 'verify', email, orderDisplayId: orderId }],
  };
}

async function getOrderStatus(args, ctx) {
  if (!ctx.customer) return { result: NEEDS_VERIFICATION, blocks: [] };

  const orderResult = await db.query(
    `SELECT display_id AS "displayId", status, total, created_at AS "createdAt",
            shipped_at AS "shippedAt", delivered_at AS "deliveredAt", cancelled_at AS "cancelledAt",
            tracking_carrier AS "trackingCarrier", tracking_number AS "trackingNumber", tracking_url AS "trackingUrl"
       FROM orders WHERE id = $1`,
    [ctx.customer.orderId]
  );
  if (!orderResult.rows.length) return { result: { error: 'not_found' }, blocks: [] };

  const order = orderResult.rows[0];
  const itemsResult = await db.query(
    `SELECT id AS "itemId", name, size, color, qty, price FROM order_items WHERE order_id = $1`,
    [ctx.customer.orderId]
  );

  const items = itemsResult.rows.map((row) => ({
    itemId: row.itemId,
    name: row.name,
    size: row.size,
    color: row.color,
    qty: row.qty,
    price: paiseToRupeeString(row.price),
  }));

  const returnable = order.status === 'DELIVERED' && order.deliveredAt
    && (Date.now() - new Date(order.deliveredAt).getTime()) < RETURN_WINDOW_DAYS * 86400000;

  const payload = {
    displayId: order.displayId,
    status: order.status,
    total: paiseToRupeeString(order.total),
    placedAt: order.createdAt,
    tracking: order.trackingNumber
      ? { carrier: order.trackingCarrier, number: order.trackingNumber, url: order.trackingUrl }
      : null,
    items,
    canRequestReturn: returnable,
    canRequestCancellation: order.status === 'PENDING_PAYMENT' || order.status === 'PROCESSING',
    returnWindowDays: RETURN_WINDOW_DAYS,
  };

  return { result: payload, blocks: [{ type: 'order', order: payload }] };
}

async function proposeReturn(args, ctx) {
  if (!ctx.customer) return { result: NEEDS_VERIFICATION, blocks: [] };

  const items = Array.isArray(args.items) ? args.items : [];
  if (!items.length) {
    return { result: { error: 'no_items', message: 'Ask which items and how many of each, using itemId values from get_order_status.' }, blocks: [] };
  }

  const photoUrl = args.photoUrl ? String(args.photoUrl) : null;
  if (photoUrl && !isOwnUploadUrl(photoUrl)) {
    // Only URLs this server issued are accepted. A model that invents or is
    // tricked into passing an external URL gets refused here.
    return { result: { error: 'bad_photo', message: 'That photo URL is not one from this chat. Ask the customer to attach the photo again.' }, blocks: [] };
  }

  try {
    const proposal = await db.withTransaction(async (client) => {
      const orderResult = await client.query(
        'SELECT id, status, delivered_at FROM orders WHERE id = $1',
        [ctx.customer.orderId]
      );
      const order = orderResult.rows[0];
      if (!order) throw new ReturnEligibilityError('We could not find that order.');

      // Same eligibility gate the customer-facing return form uses, so the
      // agent cannot queue something the store would never accept.
      checkOrderEligibility(order);

      const requested = items.map((item) => ({
        orderItemId: String(item.itemId || item.orderItemId || ''),
        quantity: Math.max(1, Math.trunc(Number(item.quantity) || 1)),
      }));
      // Throws if an item does not belong to this order or the quantity is
      // more than was bought. The refund figure it returns is for the
      // reviewer's information only, it is recomputed at approval time.
      const { resolved, totalRefund } = await resolveReturnItems(client, order.id, requested);

      const id = newId();
      const displayId = newDisplayId('REQ');
      await client.query(
        `INSERT INTO pending_actions (id, display_id, session_id, order_id, customer_email, kind, payload, agent_reasoning)
         VALUES ($1, $2, $3, $4, $5, 'RETURN', $6, $7)`,
        [
          id, displayId, ctx.sessionId, order.id, ctx.customer.email,
          JSON.stringify({
            items: resolved,
            reason: args.reason || 'Not as described',
            description: String(args.description || '').slice(0, 1000),
            photoUrl,
            estimatedRefund: totalRefund,
          }),
          String(args.reasoning || '').slice(0, 500),
        ]
      );
      return { id, displayId, estimatedRefund: totalRefund, items: resolved };
    });

    // Scoring runs after the row exists and never blocks the reply. A slow
    // or failed vision call must not make the customer wait or see an error
    // for a return that was in fact submitted.
    scoreInBackground({
      table: 'pending_actions',
      id: proposal.id,
      photoUrl,
      reason: args.reason,
      description: args.description,
    });

    const summary = {
      kind: 'RETURN',
      displayId: proposal.displayId,
      status: 'PENDING',
      estimatedRefund: paiseToRupeeString(proposal.estimatedRefund),
      photoAttached: Boolean(photoUrl),
    };

    return {
      result: {
        submitted: true,
        requestId: proposal.displayId,
        status: 'PENDING_REVIEW',
        message: 'Sent for review. Tell the customer it is being reviewed and they will get an email with the decision. Do not say it is approved or that money is coming back.',
        estimatedRefund: summary.estimatedRefund,
      },
      blocks: [{ type: 'proposal', proposal: summary }],
    };
  } catch (err) {
    if (err instanceof ReturnEligibilityError) {
      return { result: { error: 'not_eligible', message: err.message }, blocks: [] };
    }
    throw err;
  }
}

async function proposeCancellation(args, ctx) {
  if (!ctx.customer) return { result: NEEDS_VERIFICATION, blocks: [] };

  const orderResult = await db.query('SELECT id, display_id, status FROM orders WHERE id = $1', [ctx.customer.orderId]);
  const order = orderResult.rows[0];
  if (!order) return { result: { error: 'not_found' }, blocks: [] };

  if (order.status !== 'PENDING_PAYMENT' && order.status !== 'PROCESSING') {
    return {
      result: {
        error: 'too_late',
        message: `This order is already ${order.status}. Cancellation is only possible before it ships. Offer a return instead if it has been delivered.`,
      },
      blocks: [],
    };
  }

  const existing = await db.query(
    `SELECT display_id FROM pending_actions WHERE order_id = $1 AND kind = 'CANCELLATION' AND status = 'PENDING'`,
    [order.id]
  );
  if (existing.rows.length) {
    return {
      result: { error: 'already_requested', requestId: existing.rows[0].display_id, message: 'A cancellation request for this order is already waiting for review.' },
      blocks: [],
    };
  }

  const displayId = newDisplayId('REQ');
  await db.query(
    `INSERT INTO pending_actions (id, display_id, session_id, order_id, customer_email, kind, payload, agent_reasoning)
     VALUES ($1, $2, $3, $4, $5, 'CANCELLATION', $6, $7)`,
    [
      newId(), displayId, ctx.sessionId, order.id, ctx.customer.email,
      JSON.stringify({ reason: String(args.reason || '').slice(0, 500) }),
      String(args.reasoning || '').slice(0, 500),
    ]
  );

  return {
    result: {
      submitted: true,
      requestId: displayId,
      status: 'PENDING_REVIEW',
      message: 'Sent for review. Tell the customer the request is with the team and they will hear back by email. Do not say the order is cancelled.',
    },
    blocks: [{ type: 'proposal', proposal: { kind: 'CANCELLATION', displayId, status: 'PENDING' } }],
  };
}

const executors = {
  search_catalog: searchCatalog,
  get_store_policy: getStorePolicy,
  check_offers: checkOffers,
  suggest_add_ons: suggestAddOns,
  request_verification: requestVerification,
  get_order_status: getOrderStatus,
  propose_return: proposeReturn,
  propose_cancellation: proposeCancellation,
};

/**
 * Runs one tool call. A tool that throws returns an error result to the
 * model rather than failing the chat request, so one bad call degrades into
 * "I could not look that up" instead of a dead conversation.
 */
async function execute(name, args, ctx) {
  const executor = executors[name];
  if (!executor) {
    return { result: { error: 'unknown_tool', message: `There is no tool called ${name}.` }, blocks: [] };
  }
  if (args && args.__parseError) {
    return { result: { error: 'bad_arguments', message: 'Those arguments were not valid JSON, try again.' }, blocks: [] };
  }
  try {
    return await executor(args || {}, ctx);
  } catch (err) {
    console.error(`Tool ${name} failed:`, err.message);
    return { result: { error: 'tool_failed', message: 'That lookup failed. Tell the customer you could not check right now.' }, blocks: [] };
  }
}

module.exports = { definitions, execute, NEEDS_VERIFICATION };
