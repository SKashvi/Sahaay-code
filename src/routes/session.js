const express = require('express');
const { env } = require('../config/env');
const { validateBody } = require('../middleware/validate');
const { requestCodeSchema, verifyCodeSchema, sessionStateSchema } = require('../schemas');
const { verificationLimiter, verifyAttemptLimiter } = require('../middleware/rateLimiters');
const { signCustomerToken } = require('../lib/auth');
const { customerForSession } = require('../middleware/customerAuth');
const { requestCode, verifyCode, CODE_TTL_MINUTES } = require('../lib/agent/verification');

const router = express.Router();

/* The widget posts the code here directly, never through the chat. That
 * keeps the credential out of the model's context entirely, so a prompt
 * injection cannot talk its way into a verified session. */

const isProduction = env.NODE_ENV === 'production';

const COOKIE_OPTS = {
  httpOnly: true,
  secure: isProduction,
  // The embed runs on the client's own domain and calls this API cross site,
  // so the cookie has to be SameSite=None in production, which browsers only
  // accept alongside Secure. Locally over http that combination is rejected,
  // hence lax in development.
  sameSite: isProduction ? 'none' : 'lax',
  maxAge: 2 * 60 * 60 * 1000,
  path: '/',
};

router.post('/request-code', verificationLimiter, validateBody(requestCodeSchema), async (req, res, next) => {
  try {
    // displayId is optional and is only a hint about where to land. Signing
    // in is on the email, which is where the code goes.
    const { sessionId, email, displayId } = req.body;
    await requestCode({ sessionId, email, displayId: displayId || null });
    // Always the same response. Anything conditional here turns this into a
    // free tool for checking whether an email placed a given order.
    res.json({
      ok: true,
      message: `If those details match an order, a code is on its way. It expires in ${CODE_TTL_MINUTES} minutes.`,
    });
  } catch (err) {
    next(err);
  }
});

router.post('/verify', verifyAttemptLimiter, validateBody(verifyCodeSchema), async (req, res, next) => {
  try {
    const { sessionId, code } = req.body;
    const result = await verifyCode({ sessionId, code });
    if (!result.ok) {
      const message = result.reason === 'too_many_attempts'
        ? 'Too many incorrect codes. Ask for a new one.'
        : 'That code is not right, or it has expired. Ask for a new one.';
      return res.status(401).json({ error: message });
    }

    const token = signCustomerToken({
      sessionId,
      email: result.email,
      orderId: result.orderId,
      orderDisplayId: result.orderDisplayId,
    });
    res.cookie('customer_session', token, COOKIE_OPTS);
    res.json({ ok: true, orderDisplayId: result.orderDisplayId, email: result.email });
  } catch (err) {
    next(err);
  }
});

router.post('/state', validateBody(sessionStateSchema), (req, res) => {
  const customer = customerForSession(req, req.body.sessionId);
  if (!customer) return res.json({ verified: false });
  res.json({ verified: true, email: customer.email, orderDisplayId: customer.orderDisplayId });
});

router.post('/signout', (req, res) => {
  res.clearCookie('customer_session', { ...COOKIE_OPTS, maxAge: undefined });
  res.json({ ok: true });
});

module.exports = router;
