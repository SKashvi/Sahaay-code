/* Offer pricing.
 *
 * Every figure here is computed server side from the offers table and the
 * products table. The client sends a code, never an amount. A browser that
 * posts discount: 999999 changes nothing, because the discount is never read
 * from the request.
 *
 * All money is in paise, matching the rest of the system.
 */

const db = require('./db');

class OfferError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OfferError';
    this.status = 400;
  }
}

/**
 * One spelling for a code, applied to both sides of the comparison.
 *
 * A customer reads FEST10 off a poster and types "fest 10". Trimming and
 * upper-casing already happened; the space in the middle did not, so the code
 * was rejected and the order went through at full price. Stored codes are
 * normalised too, so a code saved from the dashboard with a stray space still
 * matches what a customer types without one.
 */
function normalizeOfferCode(code) {
  return String(code == null ? '' : code).replace(/\s+/g, '').toUpperCase();
}

/** Looks up a code and checks it is usable right now. Returns null for a
 * blank code, throws for a code the customer actually typed and got wrong,
 * so a typo is reported rather than silently ignored at full price. */
async function findUsableOffer(client, code) {
  const normalized = normalizeOfferCode(code);
  if (!normalized) return null;
  const result = await (client || db).query(
    // [[:space:]] rather than \\s: a POSIX class needs no backslash, so the
    // pattern cannot be mangled by a change in standard_conforming_strings.
    `SELECT id, code, title, kind, value, min_subtotal AS "minSubtotal", product_ids AS "productIds"
       FROM offers
      WHERE active = true
        AND code IS NOT NULL
        AND upper(regexp_replace(code, '[[:space:]]', '', 'g')) = $1
        AND (starts_at IS NULL OR starts_at <= now())
        AND (ends_at IS NULL OR ends_at > now())`,
    [normalized]
  );
  if (!result.rows.length) throw new OfferError('That offer code is not valid right now.');
  return result.rows[0];
}

/**
 * Works out what an offer is worth against a specific cart.
 *
 * @param offer     row from findUsableOffer, or null
 * @param subtotal  cart subtotal in paise, computed from the products table
 * @param items     [{ productId, lineTotal }] used for product-scoped offers
 * @param shipping  shipping in paise before the offer is applied
 * @returns { discount, shipping, offerCode, title }
 */
function applyOffer(offer, subtotal, items, shipping) {
  if (!offer) return { discount: 0, shipping, offerCode: null, title: null };

  if (subtotal < offer.minSubtotal) {
    throw new OfferError('This order does not reach the minimum spend for that offer.');
  }

  // A product-scoped offer only discounts the lines it names. Applying it to
  // the whole cart is the classic way a 20% off one item becomes 20% off
  // everything.
  const scoped = offer.productIds && offer.productIds.length;
  const base = scoped
    ? items.filter((item) => offer.productIds.includes(item.productId)).reduce((sum, item) => sum + item.lineTotal, 0)
    : subtotal;

  if (scoped && base === 0) {
    throw new OfferError('That offer does not apply to anything in this cart.');
  }

  let discount = 0;
  let nextShipping = shipping;

  if (offer.kind === 'PERCENT') {
    discount = Math.floor((base * offer.value) / 100);
  } else if (offer.kind === 'FLAT') {
    discount = Math.min(offer.value, base);
  } else if (offer.kind === 'FREE_SHIPPING') {
    nextShipping = 0;
  }
  // BUNDLE is descriptive only. It groups products for suggestions and does
  // not change the price, so it is deliberately not handled here.

  // A discount can never exceed the subtotal, and can never make a total
  // negative, no matter what a percentage and a flat offer would produce.
  discount = Math.max(0, Math.min(discount, subtotal));

  return { discount, shipping: nextShipping, offerCode: offer.code, title: offer.title };
}

/**
 * The fraction of the sticker price the customer actually paid.
 *
 * A discount belongs to the order, not to any one line, so refunding an item
 * at its full recorded price would refund more than was paid. This ratio is
 * stored on the order at checkout and used at refund time, so a return
 * months later uses the figure from the day of purchase even if the offer
 * has since been edited or deleted.
 */
function computeRefundRatio(subtotal, discount) {
  if (!subtotal || subtotal <= 0) return 1;
  const ratio = (subtotal - discount) / subtotal;
  if (!Number.isFinite(ratio) || ratio < 0) return 1;
  return Math.min(1, ratio);
}

module.exports = { findUsableOffer, applyOffer, computeRefundRatio, normalizeOfferCode, OfferError };
