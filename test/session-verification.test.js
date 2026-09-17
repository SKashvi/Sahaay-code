/* Run with: node test/session-verification.test.js
 *
 * Needs a real DATABASE_URL, like the other data tests here. Covers the
 * rules that decide whether a chat session may see an order, because this is
 * the one new surface in the agent work where a mistake leaks a stranger's
 * address and order history.
 *
 * EMAIL_PROVIDER=console is forced so the code is logged, not mailed.
 */

require('dotenv').config();
process.env.EMAIL_PROVIDER = 'console';

const assert = require('assert');
const crypto = require('crypto');
const db = require('../src/lib/db');
const { newId, newDisplayId } = require('../src/lib/ids');
const { requestCode, verifyCode, MAX_ATTEMPTS } = require('../src/lib/agent/verification');

async function createOrder(email) {
  const id = newId();
  const displayId = newDisplayId('TST');
  await db.query(
    `INSERT INTO orders (id, display_id, customer_name, customer_email, customer_phone,
                         address_line, city, state, pincode, subtotal, shipping, total, status)
     VALUES ($1,$2,'Test Person',$3,'9999999999','1 Test Road','Lucknow','UP','226001',100000,0,100000,'PROCESSING')`,
    [id, displayId, email]
  );
  return { id, displayId };
}

/** The code is only ever stored hashed, so a test cannot read it back. It is
 * taken from the console transport's output instead, which is exactly what a
 * developer running locally sees. */
function captureCode(fn) {
  const original = console.log;
  let captured = null;
  console.log = (...args) => {
    const line = args.map(String).join(' ');
    const match = line.match(/\b(\d{6})\b/);
    if (match && !captured) captured = match[1];
  };
  return Promise.resolve(fn()).finally(() => { console.log = original; }).then(() => captured);
}

async function main() {
  const email = `verify-test-${crypto.randomBytes(4).toString('hex')}@example.com`;
  const order = await createOrder(email);
  let failures = 0;

  function check(name, condition) {
    if (condition) {
      console.log('  ok  ' + name);
    } else {
      failures++;
      console.log('  FAIL ' + name);
    }
  }

  // ---- a wrong email must not produce a code at all ----
  const sessionA = 'sess-' + crypto.randomBytes(6).toString('hex');
  const wrongEmailCode = await captureCode(() =>
    requestCode({ sessionId: sessionA, email: 'someone-else@example.com', displayId: order.displayId })
  );
  check('no code is issued for an email that does not match the order', wrongEmailCode === null);

  const noRowResult = await db.query('SELECT count(*)::int AS n FROM verification_codes WHERE session_id = $1', [sessionA]);
  check('no verification row is written for a mismatched email', noRowResult.rows[0].n === 0);

  // ---- the happy path ----
  const sessionB = 'sess-' + crypto.randomBytes(6).toString('hex');
  const realCode = await captureCode(() => requestCode({ sessionId: sessionB, email, displayId: order.displayId }));
  check('a code is issued when the email and order match', Boolean(realCode));

  const stored = await db.query('SELECT code_hash FROM verification_codes WHERE session_id = $1', [sessionB]);
  check('the code is stored hashed, not in plain text', stored.rows[0].code_hash !== realCode);

  const wrongAttempt = await verifyCode({ sessionId: sessionB, code: '000000' });
  check('a wrong code is rejected', wrongAttempt.ok === false);

  const good = await verifyCode({ sessionId: sessionB, code: realCode });
  check('the right code verifies', good.ok === true);
  check('verification returns the order it is bound to', good.orderId === order.id);

  // ---- single use ----
  const replay = await verifyCode({ sessionId: sessionB, code: realCode });
  check('the same code cannot be used twice', replay.ok === false);

  // ---- attempt cap ----
  const sessionC = 'sess-' + crypto.randomBytes(6).toString('hex');
  const cappedCode = await captureCode(() => requestCode({ sessionId: sessionC, email, displayId: order.displayId }));
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await verifyCode({ sessionId: sessionC, code: '111111' });
  }
  const afterCap = await verifyCode({ sessionId: sessionC, code: cappedCode });
  check('the correct code is refused once the attempt cap is hit', afterCap.ok === false && afterCap.reason === 'too_many_attempts');

  // ---- issuing a new code kills the old one ----
  const sessionD = 'sess-' + crypto.randomBytes(6).toString('hex');
  const firstCode = await captureCode(() => requestCode({ sessionId: sessionD, email, displayId: order.displayId }));
  await captureCode(() => requestCode({ sessionId: sessionD, email, displayId: order.displayId }));
  const oldCodeResult = await verifyCode({ sessionId: sessionD, code: firstCode });
  check('an older code stops working once a new one is sent', oldCodeResult.ok === false);

  // ---- expiry ----
  const sessionE = 'sess-' + crypto.randomBytes(6).toString('hex');
  const expiringCode = await captureCode(() => requestCode({ sessionId: sessionE, email, displayId: order.displayId }));
  await db.query('UPDATE verification_codes SET expires_at = now() - interval \'1 minute\' WHERE session_id = $1', [sessionE]);
  const expired = await verifyCode({ sessionId: sessionE, code: expiringCode });
  check('an expired code is refused', expired.ok === false && expired.reason === 'expired');

  // cleanup
  await db.query('DELETE FROM verification_codes WHERE email = $1', [email]);
  await db.query('DELETE FROM chat_sessions WHERE verified_email = $1', [email]);
  await db.query('DELETE FROM orders WHERE id = $1', [order.id]);

  await db.pool.end();

  if (failures) {
    console.error(`\n${failures} verification check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll session verification tests passed.');
}

main().catch(async (err) => {
  console.error('FAILED:', err.message);
  try { await db.pool.end(); } catch (e) { /* already closed */ }
  process.exit(1);
});
