const express = require('express');
const db = require('../lib/db');
const { newId, newDisplayId } = require('../lib/ids');
const { checkOrderEligibility, resolveReturnItems } = require('../lib/returns');
const { verifyPassword, signAdminToken } = require('../lib/auth');
const { refundPayment } = require('../lib/razorpay');
const { transitionOrder } = require('../lib/orderStateMachine');
const { claimReturnForRefund, finalizeRefundSuccess, finalizeRefundFailure } = require('../lib/refunds');
const { notifyOrderShipped, notifyOrderDelivered, notifyReturnDecision, notifyRefundCompleted } = require('../lib/notifications');
const { requireAdmin } = require('../middleware/adminAuth');
const { requireOperator } = require('../middleware/roles');
const { pruneOldErrors } = require('../lib/errorLog');
const { scoreInBackground, visionConfigured } = require('../lib/agent/photoScoring');
const { hashPassword } = require('../lib/auth');
const { pendingActionReviewSchema, bundleUpsertSchema, adminUserCreateSchema } = require('../schemas');
const { validateBody } = require('../middleware/validate');
const { adminLoginLimiter } = require('../middleware/rateLimiters');
const {
  adminLoginSchema,
  productUpsertSchema,
  orderStatusSchema,
  returnStatusSchema,
  kbUpsertSchema,
  inventoryAdjustSchema,
  widgetSettingsSchema,
  brandConfigSchema,
  offerUpsertSchema,
} = require('../schemas');
const { env } = require('../config/env');
const theme = require('../lib/theme');

const router = express.Router();

const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: env.NODE_ENV === 'production',
  maxAge: 8 * 60 * 60 * 1000,
  path: '/',
};

router.post('/login', adminLoginLimiter, validateBody(adminLoginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const result = await db.query('SELECT * FROM admin_users WHERE lower(email) = lower($1)', [email]);
    const admin = result.rows[0];
    // Always run bcrypt.compare even when no user was found, comparing
    // against a fixed dummy hash, so the response time does not reveal
    // whether the email exists.
    const dummyHash = '$2a$12$CwTycUXWue0Thq9StjUM0uJ8gY4b0Zpv3n4b7q9dj1zC3wZ0Q1u9O';
    const ok = await verifyPassword(password, admin ? admin.password_hash : dummyHash);
    if (!admin || !ok) {
      return res.status(401).json({ error: 'Incorrect email or password' });
    }
    const token = signAdminToken({ id: admin.id, email: admin.email, role: admin.role });
    res.cookie('admin_session', token, COOKIE_OPTS);
    res.json({ ok: true, name: admin.name, email: admin.email, role: admin.role || 'operator' });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', (req, res) => {
  res.clearCookie('admin_session', { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

router.get('/me', requireAdmin, (req, res) => {
  res.json({ email: req.admin.email, role: req.admin.role, visionEnabled: visionConfigured() });
});

/* ---------------------------- orders ---------------------------- */

router.get('/orders', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, display_id AS "displayId", customer_name AS "customerName", customer_email AS "customerEmail",
              total, status, created_at AS "createdAt"
       FROM orders ORDER BY created_at DESC LIMIT 200`
    );
    res.json({ orders: result.rows });
  } catch (err) {
    next(err);
  }
});

router.patch('/orders/:id/status', requireAdmin, validateBody(orderStatusSchema), async (req, res, next) => {
  try {
    const { status, trackingCarrier, trackingNumber, trackingUrl } = req.body;
    const order = await transitionOrder(req.params.id, status, { trackingCarrier, trackingNumber, trackingUrl });
    if (status === 'SHIPPED') {
      notifyOrderShipped({
        displayId: order.display_id, customerEmail: order.customer_email,
        trackingCarrier: order.tracking_carrier, trackingNumber: order.tracking_number, trackingUrl: order.tracking_url,
      }).catch(() => {});
    } else if (status === 'DELIVERED') {
      notifyOrderDelivered({ displayId: order.display_id, customerEmail: order.customer_email }).catch(() => {});
    }
    res.json({ ok: true, order });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- returns ---------------------------- */

router.get('/returns', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      // kind tells a return of goods apart from a cancelled order's refund.
      // Both are claims on the same money and go through the same approval,
      // so they are listed together rather than on two separate screens.
      `SELECT r.id, r.display_id AS "displayId", r.kind, r.reason, r.description, r.photo_url AS "photoUrl",
              r.status, r.created_at AS "createdAt", r.razorpay_refund_id AS "razorpayRefundId",
              r.refund_amount AS "refundAmount", r.refund_error AS "refundError",
              o.display_id AS "orderDisplayId", o.customer_email AS "customerEmail", o.status AS "orderStatus"
       FROM return_requests r JOIN orders o ON o.id = r.order_id
       ORDER BY r.created_at DESC LIMIT 200`
    );
    const returnIds = result.rows.map((r) => r.id);
    const itemsResult = returnIds.length
      ? await db.query(
          `SELECT ri.return_id AS "returnId", ri.quantity, ri.refund_amount AS "refundAmount", oi.name
           FROM return_items ri JOIN order_items oi ON oi.id = ri.order_item_id
           WHERE ri.return_id = ANY($1::uuid[])`,
          [returnIds]
        )
      : { rows: [] };
    const itemsByReturn = new Map();
    for (const row of itemsResult.rows) {
      if (!itemsByReturn.has(row.returnId)) itemsByReturn.set(row.returnId, []);
      itemsByReturn.get(row.returnId).push({ name: row.name, quantity: row.quantity, refundAmount: row.refundAmount });
    }
    const returns = result.rows.map((r) => ({ ...r, items: itemsByReturn.get(r.id) || [] }));
    res.json({ returns });
  } catch (err) {
    next(err);
  }
});

const RETURN_TRANSITIONS = { SUBMITTED: ['APPROVED', 'REJECTED'], APPROVED: [], REJECTED: [], REFUND_PENDING: [], REFUNDED: [] };

router.patch('/returns/:id/status', requireAdmin, validateBody(returnStatusSchema), async (req, res, next) => {
  try {
    const result = await db.withTransaction(async (client) => {
      const current = await client.query(
        `SELECT r.status, r.display_id AS "displayId", o.customer_email AS "customerEmail"
         FROM return_requests r JOIN orders o ON o.id = r.order_id WHERE r.id = $1 FOR UPDATE`,
        [req.params.id]
      );
      if (!current.rows.length) { const err = new Error('Return request not found'); err.status = 404; throw err; }
      const from = current.rows[0].status;
      const to = req.body.status;
      if (from === to) return current.rows[0];
      if (!(RETURN_TRANSITIONS[from] || []).includes(to)) { const err = new Error(`Cannot move a return from ${from} to ${to}.`); err.status = 400; throw err; }
      await client.query(`UPDATE return_requests SET status = $1, updated_at = now() WHERE id = $2`, [to, req.params.id]);
      return { ...current.rows[0], status: to };
    });
    if (req.body.status === 'APPROVED' || req.body.status === 'REJECTED') {
      notifyReturnDecision(result.customerEmail, result.displayId, req.body.status === 'APPROVED').catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/**
 * Actually refunds the payment behind a return, through Razorpay, rather
 * than letting an admin just flip a status label. Concurrency-safe: the
 * row is locked and moved to REFUND_PENDING before Razorpay is ever
 * called, so two nearly-simultaneous requests (a nervous double click,
 * two admin tabs) cannot both observe "not refunded yet" and both call
 * Razorpay, see src/lib/refunds.js and test/refund-concurrency.test.js.
 * The refund amount always comes from what was actually resolved at
 * return-submission time against the specific items being returned
 * (return_requests.refund_amount), never from the order's full total.
 */
router.post('/returns/:id/refund', requireAdmin, async (req, res, next) => {
  try {
    const claim = await claimReturnForRefund(req.params.id);
    if (claim.alreadyRefunded) {
      return res.json({ ok: true, alreadyRefunded: true, razorpayRefundId: claim.razorpayRefundId, refundAmount: claim.refundAmount });
    }

    let refund;
    try {
      refund = await refundPayment({
        paymentId: claim.razorpayPaymentId,
        amountPaise: claim.refundAmount,
        receipt: claim.displayId,
        returnDisplayId: claim.displayId,
        idempotencyKey: claim.refundIdempotencyKey,
      });
    } catch (err) {
      const message = (err && err.error && err.error.description) || err.message || 'Refund failed';
      await finalizeRefundFailure(req.params.id, claim.priorStatus, message);
      return res.status(502).json({ error: 'Razorpay refused or failed the refund, the return was left as it was before. Check the Razorpay dashboard for details before retrying.' });
    }

    await finalizeRefundSuccess(req.params.id, refund);
    notifyRefundCompleted(claim.customerEmail, claim.displayId, refund.amount).catch(() => {});
    res.json({ ok: true, razorpayRefundId: refund.id, refundAmount: refund.amount });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- inventory ---------------------------- */

router.get('/inventory', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT v.id, v.sku, v.size, v.color, v.stock_quantity AS "stockQuantity", v.active,
              p.id AS "productId", p.name AS "productName"
       FROM product_variants v JOIN products p ON p.id = v.product_id
       ORDER BY p.name ASC, v.size ASC, v.color ASC`
    );
    res.json({ variants: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/inventory/:variantId/adjust', requireAdmin, validateBody(inventoryAdjustSchema), async (req, res, next) => {
  try {
    const { delta, reason } = req.body;
    const result = await db.withTransaction(async (client) => {
      const updated = await client.query(
        `UPDATE product_variants SET stock_quantity = stock_quantity + $1, updated_at = now()
         WHERE id = $2 AND stock_quantity + $1 >= 0
         RETURNING id, stock_quantity AS "stockQuantity"`,
        [delta, req.params.variantId]
      );
      if (!updated.rows.length) {
        const err = new Error('That adjustment would take stock below zero, or the variant does not exist.');
        err.status = 400;
        throw err;
      }
      await client.query(
        `INSERT INTO inventory_adjustments (id, variant_id, delta, reason) VALUES ($1,$2,$3,$4)`,
        [newId(), req.params.variantId, delta, reason || null]
      );
      return updated.rows[0];
    });
    res.json({ ok: true, stockQuantity: result.stockQuantity });
  } catch (err) {
    next(err);
  }
});

router.patch('/inventory/:variantId/active', requireAdmin, async (req, res, next) => {
  try {
    const active = Boolean(req.body.active);
    const result = await db.query(
      `UPDATE product_variants SET active = $1, updated_at = now() WHERE id = $2 RETURNING id`,
      [active, req.params.variantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Variant not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- products ---------------------------- */

router.get('/products', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, slug, name, price, fabric, icon_key AS "iconKey", image_url AS "imageUrl", sizes, colors, active
       FROM products ORDER BY created_at DESC`
    );
    res.json({ products: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/products', requireAdmin, validateBody(productUpsertSchema), async (req, res, next) => {
  try {
    const p = req.body;
    const id = newId();
    await db.query(
      `INSERT INTO products (id, slug, name, price, fabric, icon_key, image_url, sizes, colors, active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, p.slug, p.name, p.price, p.fabric || null, p.iconKey, p.imageUrl || null, p.sizes, JSON.stringify(p.colors), p.active]
    );
    // Every size x color combination gets a starter variant automatically,
    // with a modest placeholder stock rather than 0, so a newly created
    // product is immediately sellable. Adjust real counts from the
    // Inventory tab, this number is a starting point, not a real count.
    const defaultStock = Number.isFinite(Number(process.env.DEFAULT_VARIANT_STOCK)) ? Math.max(0, Number(process.env.DEFAULT_VARIANT_STOCK)) : 0;
    for (const size of p.sizes) {
      for (const color of p.colors) {
        const sku = `${p.slug.toUpperCase()}-${size.toUpperCase()}-${color.name.toUpperCase().replace(/[^A-Z0-9]/g, '')}`;
        await db.query(
          `INSERT INTO product_variants (id, product_id, sku, size, color, stock_quantity) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (product_id, size, color) DO NOTHING`,
          [newId(), id, sku, size, color.name, defaultStock]
        );
      }
    }
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with that slug already exists' });
    next(err);
  }
});

router.put('/products/:id', requireAdmin, validateBody(productUpsertSchema), async (req, res, next) => {
  try {
    const p = req.body;
    const result = await db.query(
      `UPDATE products SET slug=$1, name=$2, price=$3, fabric=$4, icon_key=$5, image_url=$6, sizes=$7, colors=$8, active=$9, updated_at=now()
       WHERE id = $10 RETURNING id`,
      [p.slug, p.name, p.price, p.fabric || null, p.iconKey, p.imageUrl || null, p.sizes, JSON.stringify(p.colors), p.active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Product not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with that slug already exists' });
    next(err);
  }
});

router.delete('/products/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('UPDATE products SET active = false, updated_at = now() WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- brand config ----------------------------- */

function brandRow(row) {
  return {
    logoUrl: row.logoUrl,
    logoDarkUrl: row.logoDarkUrl,
    logoHeight: row.logoHeight,
    accent: row.accent,
    secondary: row.secondary,
    background: row.background,
    surface: row.surface,
    textColor: row.textColor,
    mutedColor: row.mutedColor,
    borderRadius: row.borderRadius,
    fontFamily: row.fontFamily,
    bubbleIcon: row.bubbleIcon,
    widgetPosition: row.widgetPosition,
    showCart: row.showCart,
    showTrackOrders: row.showTrackOrders,
  };
}

router.get('/brand', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT logo_url AS "logoUrl", logo_dark_url AS "logoDarkUrl", logo_height AS "logoHeight",
              accent, secondary, background, surface, text_color AS "textColor",
              muted_color AS "mutedColor", border_radius AS "borderRadius",
              font_family AS "fontFamily", bubble_icon AS "bubbleIcon",
              widget_position AS "widgetPosition", show_cart AS "showCart",
              show_track_orders AS "showTrackOrders"
         FROM brand_config WHERE id = 1`
    );
    res.json({ brand: brandRow(result.rows[0] || {}) });
  } catch (err) {
    next(err);
  }
});

router.put('/brand', requireAdmin, validateBody(brandConfigSchema), async (req, res, next) => {
  try {
    const fields = req.body;
    const columns = Object.keys(fields);
    if (!columns.length) return res.json({ ok: true });

    const dbNames = {
      logoUrl: 'logo_url', logoDarkUrl: 'logo_dark_url', logoHeight: 'logo_height', accent: 'accent',
      secondary: 'secondary', background: 'background', surface: 'surface', textColor: 'text_color',
      mutedColor: 'muted_color', borderRadius: 'border_radius', fontFamily: 'font_family',
      bubbleIcon: 'bubble_icon', widgetPosition: 'widget_position', showCart: 'show_cart',
      showTrackOrders: 'show_track_orders',
    };
    const usable = columns.filter((key) => Object.prototype.hasOwnProperty.call(dbNames, key));
    const setSql = usable.map((key, index) => `${dbNames[key]} = $${index + 1}`).join(', ');
    const values = usable.map((key) => fields[key]);
    await db.query(
      `INSERT INTO brand_config (id, ${usable.map((key) => dbNames[key]).join(', ')}, updated_at)
       VALUES (1, ${usable.map((_, index) => `$${index + 1}`).join(', ')}, now())
       ON CONFLICT (id) DO UPDATE SET ${setSql}, updated_at = now()`,
      values
    );

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ------------------------------- offers -------------------------------- */

function offerRow(row) {
  return {
    id: row.id,
    code: row.code,
    title: row.title,
    description: row.description,
    kind: row.kind,
    value: row.value,
    minSubtotal: row.minSubtotal,
    productIds: row.productIds || [],
    active: row.active,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

router.get('/offers', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, code, title, description, kind, value, min_subtotal AS "minSubtotal",
              product_ids AS "productIds", active, starts_at AS "startsAt", ends_at AS "endsAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
         FROM offers ORDER BY created_at DESC`
    );
    res.json({ offers: result.rows.map(offerRow) });
  } catch (err) {
    next(err);
  }
});

router.post('/offers', requireAdmin, validateBody(offerUpsertSchema), async (req, res, next) => {
  try {
    const o = req.body;
    const id = newId();
    await db.query(
      `INSERT INTO offers (id, code, title, description, kind, value, min_subtotal, product_ids, active, starts_at, ends_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, o.code || null, o.title, o.description, o.kind, o.value, o.minSubtotal, o.productIds, o.active, o.startsAt || null, o.endsAt || null]
    );
    res.status(201).json({ id });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An offer with that code already exists' });
    next(err);
  }
});

router.put('/offers/:id', requireAdmin, validateBody(offerUpsertSchema), async (req, res, next) => {
  try {
    const o = req.body;
    const result = await db.query(
      `UPDATE offers SET code=$1, title=$2, description=$3, kind=$4, value=$5, min_subtotal=$6,
              product_ids=$7, active=$8, starts_at=$9, ends_at=$10, updated_at=now()
         WHERE id=$11 RETURNING id`,
      [o.code || null, o.title, o.description, o.kind, o.value, o.minSubtotal, o.productIds, o.active, o.startsAt || null, o.endsAt || null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Offer not found' });
    res.json({ ok: true });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An offer with that code already exists' });
    next(err);
  }
});

router.delete('/offers/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM offers WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Offer not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- widget settings ---------------------------- */

router.get('/widget-settings', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT welcome_message AS "welcomeMessage", suggested_questions AS "suggestedQuestions"
       FROM widget_settings WHERE id = 1`
    );
    res.json({ settings: result.rows[0] || { welcomeMessage: 'Hi! How can I help you today?', suggestedQuestions: [] } });
  } catch (err) { next(err); }
});

router.put('/widget-settings', requireAdmin, validateBody(widgetSettingsSchema), async (req, res, next) => {
  try {
    const { welcomeMessage, suggestedQuestions } = req.body;
    await db.query(
      `INSERT INTO widget_settings (id, welcome_message, suggested_questions, updated_at)
       VALUES (1, $1, $2, now())
       ON CONFLICT (id) DO UPDATE SET
         welcome_message = EXCLUDED.welcome_message,
         suggested_questions = EXCLUDED.suggested_questions,
         updated_at = now()`,
      [welcomeMessage, suggestedQuestions]
    );
    res.json({ ok: true });
  } catch (err) { next(err); }
});

/* ---------------------------- knowledge base ---------------------------- */

router.get('/knowledge-base', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, topic, content, active FROM knowledge_base_entries ORDER BY topic ASC`
    );
    res.json({ entries: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/knowledge-base', requireAdmin, validateBody(kbUpsertSchema), async (req, res, next) => {
  try {
    const { topic, content, active } = req.body;
    const id = newId();
    await db.query(
      `INSERT INTO knowledge_base_entries (id, topic, content, active) VALUES ($1,$2,$3,$4)`,
      [id, topic, content, active]
    );
    res.status(201).json({ id });
  } catch (err) {
    next(err);
  }
});

router.put('/knowledge-base/:id', requireAdmin, validateBody(kbUpsertSchema), async (req, res, next) => {
  try {
    const { topic, content, active } = req.body;
    const result = await db.query(
      `UPDATE knowledge_base_entries SET topic=$1, content=$2, active=$3, updated_at=now() WHERE id=$4 RETURNING id`,
      [topic, content, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Entry not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/knowledge-base/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.query('DELETE FROM knowledge_base_entries WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ---------------------- pending actions (agent proposals) ---------------- */

/* Everything the chat agent wants to do to an order lands here first. The
 * agent can only ever create a PENDING row. Approving one is what actually
 * creates a return or cancels an order, and it happens through the same
 * functions the rest of this dashboard uses, so an approval cannot take a
 * shortcut past eligibility checks or the order state machine. */

router.get('/pending-actions', requireAdmin, async (req, res, next) => {
  try {
    const status = ['PENDING', 'APPROVED', 'REJECTED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const result = await db.query(
      `SELECT a.id, a.display_id AS "displayId", a.kind, a.status, a.payload, a.agent_reasoning AS "agentReasoning",
              a.ai_score AS "aiScore", a.ai_verdict AS "aiVerdict", a.ai_reasoning AS "aiReasoning",
              a.customer_email AS "customerEmail", a.session_id AS "sessionId", a.created_at AS "createdAt",
              a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", a.result_ref AS "resultRef",
              o.display_id AS "orderDisplayId", o.status AS "orderStatus", o.total AS "orderTotal"
         FROM pending_actions a
         JOIN orders o ON o.id = a.order_id
        WHERE a.status = $1
        ORDER BY a.created_at DESC
        LIMIT 100`,
      [status]
    );
    res.json({ actions: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/pending-actions/:id/approve', requireAdmin, validateBody(pendingActionReviewSchema), async (req, res, next) => {
  try {
    const actionResult = await db.query(
      `SELECT id, order_id, kind, payload, customer_email, status,
              ai_score AS "aiScore", ai_verdict AS "aiVerdict", ai_reasoning AS "aiReasoning", ai_model AS "aiModel"
         FROM pending_actions WHERE id = $1`,
      [req.params.id]
    );
    const action = actionResult.rows[0];
    if (!action) return res.status(404).json({ error: 'Request not found' });
    if (action.status !== 'PENDING') return res.status(409).json({ error: 'This request has already been reviewed.' });

    if (action.kind === 'RETURN') {
      const outcome = await db.withTransaction(async (client) => {
        const orderResult = await client.query(
          'SELECT id, display_id, status, delivered_at FROM orders WHERE id = $1',
          [action.order_id]
        );
        const order = orderResult.rows[0];
        // Re-checked at approval time, not trusted from when the agent
        // proposed it. Days pass between the two, and the return window can
        // close in between.
        checkOrderEligibility(order);

        const requested = (action.payload.items || []).map((item) => ({
          orderItemId: item.orderItemId,
          quantity: item.quantity,
        }));
        // The refund amount is recomputed here from the order's real
        // recorded prices. Whatever the agent estimated is ignored.
        const { resolved, totalRefund } = await resolveReturnItems(client, order.id, requested);

        const returnId = newId();
        const returnDisplayId = newDisplayId('RET');
        await client.query(
          `INSERT INTO return_requests (id, display_id, order_id, reason, description, photo_url, refund_amount, status,
                                        ai_score, ai_verdict, ai_reasoning, ai_model)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVED',$8,$9,$10,$11)`,
          [
            returnId, returnDisplayId, order.id,
            action.payload.reason || 'Not as described',
            action.payload.description || null,
            action.payload.photoUrl || null,
            totalRefund,
            // Carried over so the score stays attached to the return a
            // reviewer sees later, rather than being stranded on a
            // pending_actions row nobody opens again.
            action.aiScore, action.aiVerdict, action.aiReasoning, action.aiModel,
          ]
        );
        for (const item of resolved) {
          await client.query(
            `INSERT INTO return_items (id, return_id, order_item_id, quantity, refund_amount) VALUES ($1,$2,$3,$4,$5)`,
            [newId(), returnId, item.orderItemId, item.quantity, item.refundAmount]
          );
        }
        await client.query(
          `UPDATE pending_actions SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $2, review_note = $3, result_ref = $4
            WHERE id = $1`,
          [action.id, req.admin.email, req.body.note || null, returnDisplayId]
        );
        return { returnDisplayId, totalRefund };
      });

      // Approving creates the return and marks it approved. It does NOT send
      // money. The refund still runs through POST /returns/:id/refund, so
      // Razorpay is only ever touched by an explicit, separate click.
      notifyReturnDecision(action.customer_email, outcome.returnDisplayId, true).catch(() => {});
      return res.json({ ok: true, kind: 'RETURN', returnDisplayId: outcome.returnDisplayId, refundAmount: outcome.totalRefund });
    }

    if (action.kind === 'CANCELLATION') {
      // Goes through the same state machine as the dashboard's own status
      // control, so an invalid transition (already shipped, already
      // cancelled) is refused here exactly as it would be there.
      const order = await transitionOrder(action.order_id, 'CANCELLED');
      await db.query(
        `UPDATE pending_actions SET status = 'APPROVED', reviewed_at = now(), reviewed_by = $2, review_note = $3, result_ref = $4
          WHERE id = $1`,
        [action.id, req.admin.email, req.body.note || null, order.display_id]
      );
      return res.json({ ok: true, kind: 'CANCELLATION', order });
    }

    return res.status(400).json({ error: 'Unknown request type' });
  } catch (err) {
    next(err);
  }
});

router.post('/pending-actions/:id/reject', requireAdmin, validateBody(pendingActionReviewSchema), async (req, res, next) => {
  try {
    const result = await db.query(
      `UPDATE pending_actions
          SET status = 'REJECTED', reviewed_at = now(), reviewed_by = $2, review_note = $3
        WHERE id = $1 AND status = 'PENDING'
        RETURNING display_id AS "displayId", customer_email AS "customerEmail"`,
      [req.params.id, req.admin.email, req.body.note || null]
    );
    if (!result.rows.length) return res.status(409).json({ error: 'Request not found or already reviewed.' });
    res.json({ ok: true, displayId: result.rows[0].displayId });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- widget theme ----------------------------- */

/* Layer 3 of the theme resolution order. Every field is optional and a blank
 * one is stored as NULL, which means "no opinion" and lets the environment
 * variable or the built-in default underneath it show through again. That is
 * what makes Reset to defaults a real reset rather than a second set of
 * hardcoded values.
 *
 * Validated with the same functions lib/theme.js uses when reading, so a value
 * cannot be stored that the resolver would later refuse. These end up as CSS
 * custom property values, so a rejected field is dropped rather than repaired.
 */
router.get('/theme', requireAdmin, async (req, res, next) => {
  try {
    const row = await db.query(
      `SELECT accent, accent_ink AS "accentInk", bg, tint_from AS "tintFrom", tint_to AS "tintTo",
              ink, radius_shell AS "radiusShell", radius_card AS "radiusCard", font,
              header_style AS "headerStyle", density, logo_url AS "logoUrl",
              greeting, suggestions, updated_at AS "updatedAt"
         FROM widget_theme WHERE id = 1`
    );
    res.json({
      // What is stored, which may be mostly nulls.
      saved: row.rows[0] || {},
      // What the widget will actually render with, once env and the defaults
      // are layered in. The preview pane needs this, not the nulls.
      resolved: await theme.resolveTheme(),
      defaults: theme.DEFAULTS,
    });
  } catch (err) {
    next(err);
  }
});

router.put('/theme', requireAdmin, requireOperator, async (req, res, next) => {
  try {
    const body = req.body || {};
    // An empty string is an explicit "clear this", which is not the same as a
    // field the form did not send at all. Both become NULL here; the
    // difference only matters to a partial update, which this is not.
    const blank = (value) => value === '' || value === null || value === undefined;

    const fields = {
      accent: blank(body.accent) ? null : theme.cleanColor(body.accent),
      accent_ink: blank(body.accentInk) ? null : theme.cleanColor(body.accentInk),
      bg: blank(body.bg) ? null : theme.cleanColor(body.bg),
      tint_from: blank(body.tintFrom) ? null : theme.cleanColor(body.tintFrom),
      tint_to: blank(body.tintTo) ? null : theme.cleanColor(body.tintTo),
      ink: blank(body.ink) ? null : theme.cleanColor(body.ink),
      radius_shell: blank(body.radiusShell) ? null : theme.cleanRadius(body.radiusShell, 64),
      radius_card: blank(body.radiusCard) ? null : theme.cleanRadius(body.radiusCard, 48),
      font: blank(body.font) ? null : theme.cleanFont(body.font),
      header_style: blank(body.headerStyle) ? null : theme.cleanEnum(body.headerStyle, ['floating', 'solid']),
      density: blank(body.density) ? null : theme.cleanEnum(body.density, ['comfortable', 'compact']),
      logo_url: blank(body.logoUrl) ? null : theme.cleanUrl(body.logoUrl),
      greeting: blank(body.greeting) ? null : theme.cleanText(body.greeting, 200),
      suggestions: blank(body.suggestions) ? null : theme.cleanSuggestions(body.suggestions),
    };

    // A value that was sent but did not survive validation is reported, not
    // silently dropped. Saving a theme and finding one field quietly missing
    // is worse than being told the hex was malformed.
    const rejected = Object.keys(fields).filter((column) => {
      const sent = {
        accent: body.accent, accent_ink: body.accentInk, bg: body.bg,
        tint_from: body.tintFrom, tint_to: body.tintTo, ink: body.ink,
        radius_shell: body.radiusShell, radius_card: body.radiusCard,
        font: body.font, header_style: body.headerStyle, density: body.density,
        logo_url: body.logoUrl, greeting: body.greeting, suggestions: body.suggestions,
      }[column];
      return !blank(sent) && fields[column] === null;
    });
    if (rejected.length) {
      return res.status(400).json({
        error: `These values were not accepted: ${rejected.join(', ')}. Colours must be hex, radii are pixels, and suggestions must be 3 to 5 questions.`,
      });
    }

    await db.query(
      `UPDATE widget_theme SET
         accent = $1, accent_ink = $2, bg = $3, tint_from = $4, tint_to = $5, ink = $6,
         radius_shell = $7, radius_card = $8, font = $9, header_style = $10, density = $11,
         logo_url = $12, greeting = $13, suggestions = $14, updated_at = now()
       WHERE id = 1`,
      [
        fields.accent, fields.accent_ink, fields.bg, fields.tint_from, fields.tint_to, fields.ink,
        fields.radius_shell, fields.radius_card, fields.font, fields.header_style, fields.density,
        fields.logo_url, fields.greeting, fields.suggestions ? JSON.stringify(fields.suggestions) : null,
      ]
    );

    // The widget reads the theme on every load, so this takes effect on the
    // next page view with no redeploy.
    res.json({ ok: true, resolved: await theme.resolveTheme() });
  } catch (err) {
    next(err);
  }
});

/* Clears every column back to NULL, which hands control back to the
 * environment variables and then the built-in defaults. */
router.post('/theme/reset', requireAdmin, requireOperator, async (req, res, next) => {
  try {
    await db.query(
      `UPDATE widget_theme SET accent = NULL, accent_ink = NULL, bg = NULL, tint_from = NULL,
         tint_to = NULL, ink = NULL, radius_shell = NULL, radius_card = NULL, font = NULL,
         header_style = NULL, density = NULL, logo_url = NULL, greeting = NULL,
         suggestions = NULL, updated_at = now() WHERE id = 1`
    );
    res.json({ ok: true, resolved: await theme.resolveTheme() });
  } catch (err) {
    next(err);
  }
});

/* ------------------------- conversations ------------------------- */

/* The chat transcript. This is the answer to "the assistant said something
 * wrong yesterday", which was previously unanswerable: messages were being
 * written since the first version and nothing ever read them. */

router.get('/conversations', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT m.session_id AS "sessionId",
              count(*)::int AS "messageCount",
              max(m.created_at) AS "lastMessageAt",
              min(m.created_at) AS "startedAt",
              s.verified_email AS "verifiedEmail",
              o.display_id AS "orderDisplayId",
              (array_agg(m.content ORDER BY m.created_at DESC))[1] AS "lastMessage"
         FROM chat_messages m
         LEFT JOIN chat_sessions s ON s.id = m.session_id
         LEFT JOIN orders o ON o.id = s.verified_order_id
        GROUP BY m.session_id, s.verified_email, o.display_id
        ORDER BY max(m.created_at) DESC
        LIMIT 100`
    );
    res.json({ conversations: result.rows });
  } catch (err) {
    next(err);
  }
});

router.get('/conversations/:sessionId', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT role, content, blocks, created_at AS "createdAt"
         FROM chat_messages WHERE session_id = $1
        ORDER BY created_at ASC LIMIT 500`,
      [req.params.sessionId]
    );
    const session = await db.query(
      `SELECT s.verified_email AS "verifiedEmail", s.verified_at AS "verifiedAt", o.display_id AS "orderDisplayId"
         FROM chat_sessions s LEFT JOIN orders o ON o.id = s.verified_order_id
        WHERE s.id = $1`,
      [req.params.sessionId]
    );
    res.json({ messages: result.rows, session: session.rows[0] || null });
  } catch (err) {
    next(err);
  }
});

/* ---------------------------- error log --------------------------- */

/* Operator only. A client seeing raw provider errors and stack detail from
 * their own deployment is noise at best and confusing at worst, and this is
 * the surface the agency uses to support them. */

router.get('/errors', requireAdmin, requireOperator, async (req, res, next) => {
  try {
    // Pruning here rather than on a schedule keeps this to one process with
    // no extra job to deploy or forget.
    pruneOldErrors(30).catch(() => {});
    const source = typeof req.query.source === 'string' ? req.query.source : '';
    const result = await db.query(
      `SELECT id, source, message, detail, context, created_at AS "createdAt"
         FROM error_log
        WHERE ($1 = '' OR source = $1)
        ORDER BY created_at DESC
        LIMIT 200`,
      [source]
    );
    res.json({ errors: result.rows });
  } catch (err) {
    next(err);
  }
});

/* --------------------------- admin users -------------------------- */

router.get('/users', requireAdmin, requireOperator, async (req, res, next) => {
  try {
    const result = await db.query(
      'SELECT id, name, email, role, created_at AS "createdAt" FROM admin_users ORDER BY created_at ASC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/users', requireAdmin, requireOperator, validateBody(adminUserCreateSchema), async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    const passwordHash = await hashPassword(password);
    const result = await db.query(
      'INSERT INTO admin_users (id, name, email, password_hash, role) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role',
      [newId(), name, email.toLowerCase(), passwordHash, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'An account with that email already exists' });
    next(err);
  }
});

router.delete('/users/:id', requireAdmin, requireOperator, async (req, res, next) => {
  try {
    // Removing your own account, or the last operator, would lock everyone
    // out of the areas only an operator can reach.
    if (req.params.id === req.admin.sub) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }
    const operators = await db.query("SELECT count(*)::int AS n FROM admin_users WHERE role = 'operator'");
    const target = await db.query('SELECT role FROM admin_users WHERE id = $1', [req.params.id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Account not found' });
    if (target.rows[0].role === 'operator' && operators.rows[0].n <= 1) {
      return res.status(400).json({ error: 'This is the only operator account, it cannot be removed.' });
    }
    await db.query('DELETE FROM admin_users WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/* ----------------------------- bundles ---------------------------- */

router.get('/bundles', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query(
      `SELECT id, title, description, product_ids AS "productIds", active, created_at AS "createdAt"
         FROM bundles ORDER BY created_at DESC`
    );
    res.json({ bundles: result.rows });
  } catch (err) {
    next(err);
  }
});

router.post('/bundles', requireAdmin, validateBody(bundleUpsertSchema), async (req, res, next) => {
  try {
    const { title, description, productIds, active } = req.body;
    const result = await db.query(
      'INSERT INTO bundles (id, title, description, product_ids, active) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [newId(), title, description, productIds, active]
    );
    res.status(201).json({ id: result.rows[0].id });
  } catch (err) {
    next(err);
  }
});

router.put('/bundles/:id', requireAdmin, validateBody(bundleUpsertSchema), async (req, res, next) => {
  try {
    const { title, description, productIds, active } = req.body;
    const result = await db.query(
      'UPDATE bundles SET title=$1, description=$2, product_ids=$3, active=$4, updated_at=now() WHERE id=$5 RETURNING id',
      [title, description, productIds, active, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Bundle not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.delete('/bundles/:id', requireAdmin, async (req, res, next) => {
  try {
    const result = await db.query('DELETE FROM bundles WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Bundle not found' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
