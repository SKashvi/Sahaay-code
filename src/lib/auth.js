const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

const SALT_ROUNDS = 12;
const TOKEN_TTL = '8h';

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signAdminToken(adminUser) {
  return jwt.sign(
    // The role is baked into the token, so a demotion takes effect at the
    // next sign-in rather than needing a database read on every request.
    // Token lifetime is 8h, which bounds how long a stale role can last.
    { sub: adminUser.id, email: adminUser.email, role: 'admin', adminRole: adminUser.role || 'operator' },
    env.JWT_SECRET,
    { expiresIn: TOKEN_TTL, algorithm: 'HS256' }
  );
}

/* Customer sessions are short lived on purpose. This token is what proves a
 * chat session may see one specific order, so two hours is plenty and keeps
 * a stolen cookie from being useful for long. The order id is baked in: the
 * token authorises exactly one order, not "whatever order the request asks
 * for". */
const CUSTOMER_TOKEN_TTL = '2h';

function signCustomerToken({ sessionId, email, orderId, orderDisplayId }) {
  return jwt.sign(
    { sid: sessionId, email, orderId, orderDisplayId, role: 'customer' },
    env.JWT_SECRET,
    { expiresIn: CUSTOMER_TOKEN_TTL, algorithm: 'HS256' }
  );
}

function verifyToken(token) {
  return jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
}

module.exports = { hashPassword, verifyPassword, signAdminToken, signCustomerToken, verifyToken };
