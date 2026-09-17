const { verifyToken } = require('../lib/auth');

/* Who the customer is, for chat.
 *
 * The chat session id lives in the browser's localStorage, so it is fully
 * attacker controlled: anyone can send any session id they like. It is used
 * to group messages, never to prove identity.
 *
 * Identity comes from the signed httpOnly customer_session cookie, and the
 * cookie carries the session id it was issued for. customerForSession()
 * refuses to hand back an identity unless the two agree, so pasting someone
 * else's session id into a request gets you nothing: your cookie says a
 * different session, and without a cookie there is no identity at all.
 */

function attachCustomer(req, res, next) {
  const token = req.cookies && req.cookies.customer_session;
  if (!token) return next();
  try {
    const payload = verifyToken(token);
    if (payload.role !== 'customer') return next();
    req.customer = {
      sid: payload.sid,
      email: payload.email,
      orderId: payload.orderId,
      orderDisplayId: payload.orderDisplayId,
    };
  } catch (err) {
    // Expired or tampered token is simply an unverified visitor, not an
    // error worth failing the request over.
  }
  next();
}

function customerForSession(req, sessionId) {
  if (!req.customer) return null;
  if (req.customer.sid !== sessionId) return null;
  return req.customer;
}

module.exports = { attachCustomer, customerForSession };
