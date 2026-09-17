const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const { env } = require('./config/env');
const db = require('./lib/db');
const { notFoundHandler, errorHandler } = require('./middleware/errorHandler');
const { attachCustomer } = require('./middleware/customerAuth');

const productsRoute = require('./routes/products');
const ordersRoute = require('./routes/orders');
const paymentsRoute = require('./routes/payments');
const returnsRoute = require('./routes/returns');
const uploadsRoute = require('./routes/uploads');
const chatRoute = require('./routes/chat');
const adminRoute = require('./routes/admin');
const configRoute = require('./routes/config');
const sessionRoute = require('./routes/session');

const app = express();

const s3ImageOrigin = env.S3_PUBLIC_BASE_URL ? new URL(env.S3_PUBLIC_BASE_URL).origin : null;
const brandImageOrigin = env.BRAND_LOGO_URL ? new URL(env.BRAND_LOGO_URL).origin : null;

app.set('trust proxy', 1); // needed for correct client IPs and secure cookies behind a reverse proxy / load balancer
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://checkout.razorpay.com'],
      'connect-src': ["'self'", 'https://api.razorpay.com', 'https://lumberjack.razorpay.com'],
      'frame-src': ["'self'", 'https://api.razorpay.com', 'https://checkout.razorpay.com'],
      'img-src': ["'self'", 'data:', 'https:', ...(s3ImageOrigin ? [s3ImageOrigin] : []), ...(brandImageOrigin ? [brandImageOrigin] : [])],
      'font-src': ["'self'", 'https:', 'data:'],
    },
  },
}));
app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }));
app.use(cookieParser());
// Reads the signed customer_session cookie, if present, onto req.customer.
// Sets nothing and rejects nothing, the routes decide what to do with it.
app.use(attachCustomer);

// The Razorpay webhook needs the raw request bytes to check the signature,
// so it is mounted with express.raw() ahead of the global JSON parser below.
app.use('/api/payments', express.raw({ type: 'application/json' }), paymentsRoute);

app.use(express.json({ limit: '200kb' }));

// Liveness: is the process up at all. Deliberately checks nothing else, a
// database blip should not make an orchestrator kill and restart the app.
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Readiness: is this instance actually able to serve real requests right
// now. Checks the one dependency that matters most, the database. Point a
// load balancer or orchestrator's readiness probe at this, not /healthz.
app.get('/readiness', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ ok: true, database: 'up' });
  } catch (err) {
    res.status(503).json({ ok: false, database: 'down' });
  }
});

app.use('/api/config', configRoute);
app.use('/api/products', productsRoute);
app.use('/api/orders', ordersRoute);
app.use('/api/returns', returnsRoute);
app.use('/api/uploads', uploadsRoute);
app.use('/api/session', sessionRoute);
app.use('/api/chat', chatRoute);
app.use('/api/admin', adminRoute);

// Serves index.html, cart.html, checkout.html, track-order.html, admin.html,
// and the css/js under them. One process, one deployment, no separate
// frontend host or CORS setup needed for the common case.
const path = require('path');
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
