const rateLimit = require('express-rate-limit');

// Order lookup and returns let someone guess at an email + order id pair,
// so they get the tightest limits. Chat is limited mainly to control cost.
// Admin login is limited to slow down credential stuffing.

const trackOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes.' },
});

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'You are sending messages too quickly, please slow down.' },
});

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again in a few minutes.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads, please try again shortly.' },
});

const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again shortly.' },
});

// Previewing an offer code is a read, but it is an unauthenticated read that
// touches the database, and it sits on the checkout page where a frustrated
// customer will retype a code several times. Its own budget, so trying codes
// cannot eat into the checkout allowance and lock someone out of buying.
const offerQuoteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again shortly.' },
});

// Sending a code is an outbound email triggered by an anonymous visitor, so
// it is limited harder than ordinary lookups. Checking a code is limited
// separately: the per-code attempt counter in verification_codes stops
// guessing against one code, this stops someone cycling through many.
const verificationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many code requests, please try again in a few minutes.' },
});

const verifyAttemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again in a few minutes.' },
});

module.exports = { verificationLimiter, verifyAttemptLimiter, trackOrderLimiter, chatLimiter, adminLoginLimiter, uploadLimiter, checkoutLimiter, offerQuoteLimiter };
