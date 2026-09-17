/* Run with: npm run migrate
 * Applies every .sql file in db/migrations, in filename order, that has not
 * already been recorded as applied. Each migration runs in its own
 * transaction. Safe to run on every deploy, already-applied migrations are
 * skipped, this is what makes it safe to run against a database that
 * already has real data and real orders in it. */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { getDatabaseSslConfig } = require('../src/config/database');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL is not set, copy .env.example to .env and fill it in first.');
    process.exit(1);
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: getDatabaseSslConfig() });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename    TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const appliedResult = await pool.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedResult.rows.map((r) => r.filename));

    let ranAny = false;
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log('Applied:', file);
        ranAny = true;
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      } finally {
        client.release();
      }
    }
    console.log(ranAny ? 'All new migrations applied.' : 'Nothing to do, already up to date.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
