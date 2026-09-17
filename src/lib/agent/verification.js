/* Email code verification.
 *
 * One implementation, two callers: the agent's request_verification tool and
 * the REST endpoints in src/routes/session.js. The code itself never passes
 * through the model. The agent can ask for a code to be sent, but the
 * customer types it into the widget's own field, which posts straight to
 * /api/session/verify. That keeps a guessed or injected code from reaching
 * the verification path through a tool call.
 */

const db = require('../db');
const { newId } = require('../ids');
const { hashPassword, verifyPassword } = require('../auth');
const { sendEmail } = require('../email');
const { env } = require('../../config/env');

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

function generateCode() {
  // Six digits, uniformly distributed. Math.random is not used here because
  // this is an authentication credential, however short-lived.
  const crypto = require('crypto');
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

/**
 * Sends a login code if, and only if, the email and order id actually match
 * a real order. The caller MUST give the customer the same answer either
 * way. Saying "no such order" here would turn this endpoint into an order id
 * and email checker for anyone who wants one.
 */
async function requestCode({ sessionId, email, displayId }) {
  const orderResult = await db.query(
    `SELECT id, display_id, customer_email, customer_name
       FROM orders
      WHERE display_id = $1 AND lower(customer_email) = lower($2)`,
    [displayId, email]
  );
  if (!orderResult.rows.length) return { sent: false };

  const order = orderResult.rows[0];
  const code = generateCode();
  const codeHash = await hashPassword(code);

  await db.withTransaction(async (client) => {
    // Any earlier code for this session is dead the moment a new one is
    // issued, so an old email cannot be used later.
    await client.query(
      `UPDATE verification_codes SET consumed_at = now()
        WHERE session_id = $1 AND consumed_at IS NULL`,
      [sessionId]
    );
    await client.query(
      `INSERT INTO verification_codes (id, session_id, email, order_display_id, order_id, code_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 || ' minutes')::interval)`,
      [newId(), sessionId, order.customer_email, order.display_id, order.id, codeHash, String(CODE_TTL_MINUTES)]
    );
  });

  await sendEmail({
    to: order.customer_email,
    subject: `Your ${env.BRAND_NAME} verification code`,
    html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;">
        <h2>${env.BRAND_NAME}</h2>
        <p>Here is your code for order <strong>${order.display_id}</strong>:</p>
        <p style="font-size:32px;letter-spacing:6px;font-weight:700;">${code}</p>
        <p>It expires in ${CODE_TTL_MINUTES} minutes. If you did not ask for this, you can ignore this email.</p>
      </div>`,
    text: `Your ${env.BRAND_NAME} code for order ${order.display_id} is ${code}. It expires in ${CODE_TTL_MINUTES} minutes.`,
  });

  return { sent: true };
}

/**
 * Checks a submitted code. Returns the verified identity on success, which
 * the caller turns into a signed cookie. Never returns anything that tells
 * the submitter how close they were.
 */
async function verifyCode({ sessionId, code }) {
  const result = await db.query(
    `SELECT id, email, order_id, order_display_id, code_hash, attempts, expires_at
       FROM verification_codes
      WHERE session_id = $1 AND consumed_at IS NULL AND expires_at > now()
      ORDER BY created_at DESC
      LIMIT 1`,
    [sessionId]
  );
  if (!result.rows.length) return { ok: false, reason: 'expired' };

  const row = result.rows[0];
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' };

  // Count the attempt before checking it, so a crash or a race cannot give
  // someone a free guess.
  await db.query('UPDATE verification_codes SET attempts = attempts + 1 WHERE id = $1', [row.id]);

  const matches = await verifyPassword(String(code), row.code_hash);
  if (!matches) return { ok: false, reason: 'invalid' };

  await db.withTransaction(async (client) => {
    await client.query('UPDATE verification_codes SET consumed_at = now() WHERE id = $1', [row.id]);
    await client.query(
      `INSERT INTO chat_sessions (id, verified_email, verified_order_id, verified_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (id) DO UPDATE
         SET verified_email = EXCLUDED.verified_email,
             verified_order_id = EXCLUDED.verified_order_id,
             verified_at = now(),
             last_seen_at = now()`,
      [sessionId, row.email, row.order_id]
    );
  });

  return {
    ok: true,
    email: row.email,
    orderId: row.order_id,
    orderDisplayId: row.order_display_id,
  };
}

module.exports = { requestCode, verifyCode, CODE_TTL_MINUTES, MAX_ATTEMPTS };
