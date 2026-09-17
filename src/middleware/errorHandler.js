const { env } = require('../config/env');
const { logError } = require('../lib/errorLog');

function notFoundHandler(req, res) {
  res.status(404).json({ error: 'Not found' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  if (status >= 500) {
    console.error(err);
    // Only genuine server faults are recorded. A 400 from a bad request body
    // is the validation layer working, and logging those would bury the real
    // failures under noise from every mistyped form.
    logError({
      source: 'http',
      message: err.message || 'Unhandled error',
      detail: err.stack,
      // Path and method only. Request bodies carry addresses, emails, and
      // photo URLs, and this table is read by a human in a dashboard.
      context: { method: req.method, path: req.path, status },
    }).catch(() => {});
  }
  const body = { error: status >= 500 ? 'Something went wrong on our end.' : err.message || 'Request failed' };
  if (env.NODE_ENV !== 'production' && status >= 500) {
    body.debug = err.stack;
  }
  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
