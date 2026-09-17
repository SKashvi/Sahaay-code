const { Pool } = require('pg');
const { env } = require('../config/env');
const { getDatabaseSslConfig } = require('../config/database');

// A single shared connection pool. Every query in this app goes through
// pool.query with a parameterized ($1, $2, ...) statement. Never build SQL
// with string concatenation or template literals containing request input,
// that is the entire SQL injection surface and this file is the one place
// that touches the driver directly so it is easy to audit.
const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,
  ssl: getDatabaseSslConfig({ DATABASE_SSL: env.DATABASE_SSL, DATABASE_SSL_INSECURE: env.DATABASE_SSL_INSECURE }),
});

pool.on('error', (err) => {
  // A background/idle client error should not crash the process.
  console.error('Unexpected database pool error', err);
});

async function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
