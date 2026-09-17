/* Error log.
 *
 * Records the failures a human needs in order to answer "why did the
 * assistant do that", which is a different question from "what requests did
 * the server handle". Request logs belong in the host's logging, this table
 * is for the handful of events someone will actually go looking for.
 *
 * Writes never throw. A logger that can take down the request it was trying
 * to describe is worse than no logger, so every failure here is swallowed
 * after a console warning.
 */

const db = require('./db');
const { newId } = require('./ids');

const MAX_DETAIL_LENGTH = 4000;

/* Keys that are safe to keep. Everything else in a context object is
 * dropped rather than filtered, because an allowlist fails closed: a new
 * field added somewhere else cannot leak into the log by default. Request
 * bodies are never passed in, they carry addresses, emails and photo URLs. */
const ALLOWED_CONTEXT_KEYS = [
  'method', 'path', 'status', 'provider', 'model', 'sessionId',
  'orderDisplayId', 'tool', 'attempt', 'durationMs',
];

function sanitizeContext(context) {
  if (!context || typeof context !== 'object') return {};
  const out = {};
  for (const key of ALLOWED_CONTEXT_KEYS) {
    if (context[key] !== undefined && context[key] !== null) out[key] = String(context[key]).slice(0, 200);
  }
  return out;
}

/**
 * @param source  a short stable label: 'ai', 'chat', 'payments', 'http', 'vision'
 */
async function logError({ source, message, detail, context }) {
  try {
    await db.query(
      'INSERT INTO error_log (id, source, message, detail, context) VALUES ($1, $2, $3, $4, $5)',
      [
        newId(),
        String(source || 'unknown').slice(0, 60),
        String(message || 'Unknown error').slice(0, 500),
        detail ? String(detail).slice(0, MAX_DETAIL_LENGTH) : null,
        JSON.stringify(sanitizeContext(context)),
      ]
    );
  } catch (err) {
    console.warn('Could not write to error_log:', err.message);
  }
}

/** Keeps the table from growing without bound on a long-lived deployment.
 * Called from the admin list endpoint rather than a scheduler, so there is
 * no extra process to run. */
async function pruneOldErrors(days = 30) {
  try {
    await db.query(`DELETE FROM error_log WHERE created_at < now() - ($1 || ' days')::interval`, [String(days)]);
  } catch (err) {
    console.warn('Could not prune error_log:', err.message);
  }
}

module.exports = { logError, pruneOldErrors, sanitizeContext, ALLOWED_CONTEXT_KEYS };
