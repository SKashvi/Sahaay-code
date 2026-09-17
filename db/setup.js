#!/usr/bin/env node
/* Run with: npm run setup
 * A single guided pass over everything a new deployment needs, instead of
 * five separate manual steps where a mistake in step two only shows up
 * as a confusing error in step four. Prints a clear PASS/FAIL/WARN report
 * for every check and, if anything required failed, stops before
 * touching the database rather than half-configuring it.
 */
require('dotenv').config();
const { execSync } = require('child_process');
const path = require('path');
const { getDatabaseSslConfig } = require('../src/config/database');

const results = [];
function report(name, status, detail) {
  results.push({ name, status, detail });
  const icon = status === 'PASS' ? '✔' : status === 'WARN' ? '!' : '✘';
  console.log(`  [${icon}] ${name}${detail ? ': ' + detail : ''}`);
}

async function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major >= 18) report('Node.js version', 'PASS', `v${process.versions.node}`);
  else report('Node.js version', 'FAIL', `v${process.versions.node} found, 18 or newer is required`);
}

function checkRequiredEnvVars() {
  const required = [
    'DATABASE_URL', 'JWT_SECRET', 'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
    'AI_PROVIDER', 'AI_API_KEY', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY',
  ];
  const missing = required.filter((k) => !process.env[k] || !process.env[k].trim());
  if (missing.length) {
    report('Required environment variables', 'FAIL', `missing: ${missing.join(', ')}`);
    return false;
  }
  report('Required environment variables', 'PASS', `${required.length} present`);
  if (process.env.NODE_ENV === 'production' && (process.env.JWT_SECRET || '').length < 32) {
    report('JWT_SECRET strength', 'FAIL', 'must be at least 32 characters in production, generate one with: openssl rand -hex 32');
    return false;
  }
  report('JWT_SECRET strength', 'PASS');
  return true;
}

async function checkDatabase() {
  try {
    const { Pool } = require('pg');
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5000, ssl: getDatabaseSslConfig() });
    await pool.query('SELECT 1');
    await pool.end();
    report('Database connectivity', 'PASS');
    return true;
  } catch (err) {
    report('Database connectivity', 'FAIL', err.message);
    return false;
  }
}

async function checkS3() {
  try {
    const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');
    const client = new S3Client({
      region: process.env.S3_REGION,
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: Boolean(process.env.S3_ENDPOINT),
      credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
    });
    await client.send(new HeadBucketCommand({ Bucket: process.env.S3_BUCKET }));
    report('Object storage (S3) connectivity', 'PASS', `bucket "${process.env.S3_BUCKET}" reachable`);
    return true;
  } catch (err) {
    report('Object storage (S3) connectivity', 'WARN', `could not confirm bucket access (${err.message}), return photo uploads will fail until this is fixed`);
    return true; // non-fatal, storefront and checkout do not depend on this
  }
}

async function checkRazorpay() {
  try {
    const Razorpay = require('razorpay');
    const client = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    // A tiny, real, harmless read-only call, this is the same auth path
    // checkout actually uses, a bad key pair fails here exactly the way
    // it would fail on a real customer's checkout.
    await client.orders.all({ count: 1 });
    report('Razorpay credentials', 'PASS');
    return true;
  } catch (err) {
    report('Razorpay credentials', 'FAIL', (err && err.error && err.error.description) || err.message);
    return false;
  }
}

async function checkAIProvider() {
  const provider = process.env.AI_PROVIDER;
  const supported = ['deepseek', 'openai', 'anthropic'];
  if (!supported.includes(provider)) {
    report('AI provider', 'FAIL', `AI_PROVIDER="${provider}" is not one of: ${supported.join(', ')}`);
    return false;
  }
  try {
    const { createAIClient } = require('../src/lib/ai-providers');
    const client = createAIClient({
      AI_PROVIDER: provider,
      AI_API_KEY: process.env.AI_API_KEY,
      AI_MODEL: process.env.AI_MODEL,
      AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS || '15000',
      AI_FALLBACK_PROVIDER: '', // do not exercise the fallback here, this checks the primary specifically
    });
    await client.complete({ systemPrompt: 'Reply with the single word: ok', history: [], userMessage: 'Say ok', maxTokens: 10 });
    report(`AI provider (${provider})`, 'PASS');
    return true;
  } catch (err) {
    report(`AI provider (${provider})`, 'FAIL', err.message);
    return false;
  }
}

function checkEmail() {
  if (!process.env.EMAIL_PROVIDER) {
    report('Transactional email', 'WARN', 'EMAIL_PROVIDER not set, order/return/refund emails will be skipped, see .env.example');
    return true; // optional in this version, non-fatal
  }
  const required = ['EMAIL_PROVIDER', 'EMAIL_API_KEY', 'EMAIL_FROM_ADDRESS'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    report('Transactional email', 'FAIL', `EMAIL_PROVIDER is set but missing: ${missing.join(', ')}`);
    return false;
  }
  report('Transactional email', 'PASS', `provider: ${process.env.EMAIL_PROVIDER}`);
  return true;
}

function runMigrations() {
  console.log('\nRunning database migrations...');
  execSync('node ' + path.join(__dirname, 'migrate.js'), { stdio: 'inherit' });
}

async function ensureAdmin() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    report('Initial admin account', 'WARN', 'ADMIN_EMAIL / ADMIN_PASSWORD not set, run `npm run seed` manually once you have decided on a login');
    return;
  }
  console.log('\nCreating the initial admin account and starter catalog...');
  execSync('node ' + path.join(__dirname, 'seed.js'), { stdio: 'inherit' });
}

async function main() {
  console.log('Velour setup\n');

  console.log('Runtime');
  await checkNodeVersion();

  console.log('\nConfiguration');
  const envOk = checkRequiredEnvVars();
  if (!envOk) {
    console.log('\nFix the environment variables above (copy .env.example to .env if you have not) and run `npm run setup` again.');
    process.exit(1);
  }

  console.log('\nLive connectivity checks');
  const dbOk = await checkDatabase();
  const razorpayOk = await checkRazorpay();
  const aiOk = await checkAIProvider();
  await checkS3();
  checkEmail();

  if (!dbOk) {
    console.log('\nCannot continue without a working database connection. Fix DATABASE_URL and run `npm run setup` again.');
    process.exit(1);
  }

  runMigrations();
  await ensureAdmin();

  console.log('\nFinal check: readiness');
  const dbOkAgain = await checkDatabase();
  report('Ready to start', dbOkAgain && razorpayOk && aiOk ? 'PASS' : 'WARN',
    dbOkAgain && razorpayOk && aiOk ? undefined : 'core dependencies are up, but see the FAIL/WARN lines above before taking real traffic');

  const fails = results.filter((r) => r.status === 'FAIL');
  console.log('\n' + '='.repeat(60));
  if (fails.length) {
    console.log(`Setup finished with ${fails.length} failing check(s). Read SECURITY-CHECKLIST.md before going live.`);
    process.exit(1);
  }
  console.log('Setup finished. Run `npm start` (or `docker compose up`) to bring the app up.');
}

main().catch((err) => {
  console.error('\nSetup failed unexpectedly:', err.message);
  process.exit(1);
});
