/* Run with: node test/boot-test.js
 * Minimal regression guard for module-load failures and the Razorpay CSP.
 * It deliberately makes only the app boot and serve a static page; database
 * credentials are syntactically valid placeholders because /checkout.html
 * does not require a database query.
 */
const assert = require('assert');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:5432/test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-that-is-long-enough-for-boot';
process.env.RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'test_key';
process.env.RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'test_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET || 'test_webhook';
process.env.AI_PROVIDER = process.env.AI_PROVIDER || 'deepseek';
process.env.AI_API_KEY = process.env.AI_API_KEY || 'test_ai_key';
process.env.S3_BUCKET = process.env.S3_BUCKET || 'test-bucket';
process.env.S3_REGION = process.env.S3_REGION || 'ap-south-1';
process.env.S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || 'test_s3_key';
process.env.S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || 'test_s3_secret';
process.env.EMAIL_PROVIDER = '';

async function main() {
  let app;
  try {
    app = require('../src/app');
  } catch (err) {
    throw new Error(`APP BOOT FAILED: ${err.stack || err.message}`);
  }

  const response = await request(app).get('/checkout.html');
  assert.strictEqual(response.status, 200, `expected /checkout.html to return 200, got ${response.status}`);
  const csp = response.headers['content-security-policy'] || '';
  const scriptSrc = csp.match(/script-src[^;]*/i);
  assert(scriptSrc, `CSP missing script-src directive: ${csp}`);
  assert(scriptSrc[0].includes('https://checkout.razorpay.com'), `Razorpay checkout origin missing from script-src: ${scriptSrc[0]}`);

  /* The checkout page carries a relaxed policy so a netbanking payment can
   * post to the bank's own domain, which cannot be enumerated. Every other
   * path keeps the strict one. Both halves are asserted, because the relaxed
   * policy leaking onto the rest of the site is the failure that matters and
   * it would otherwise be invisible. */
  assert(
    /form-action[^;]*\bhttps:/.test(csp),
    `checkout CSP must allow the netbanking POST via form-action https: ${csp}`
  );
  assert(
    /frame-src[^;]*https:\/\/\*\.razorpay\.com/.test(csp),
    `checkout CSP must allow the Razorpay frame: ${csp}`
  );
  assert(
    /connect-src[^;]*https:\/\/\*\.razorpay\.com/.test(csp),
    `checkout CSP must allow Razorpay's own calls: ${csp}`
  );
  // Widening form submission is not a reason to widen code execution.
  assert(
    !/script-src[^;]*\bhttps:(\s|;|$)/.test(csp),
    `checkout script-src must NOT accept bare https:, only the named Razorpay origin: ${scriptSrc[0]}`
  );

  const homeResponse = await request(app).get('/index.html');
  const homeCsp = homeResponse.headers['content-security-policy'] || '';
  assert(homeCsp, 'every page must carry a CSP');
  assert(
    !/form-action[^;]*\bhttps:/.test(homeCsp),
    `the relaxed form-action has leaked off the checkout page: ${homeCsp}`
  );
  assert(
    !homeCsp.includes('https://*.razorpay.com'),
    `the Razorpay wildcard has leaked off the checkout page: ${homeCsp}`
  );

  const apiResponse = await request(app).get('/healthz');
  const apiCsp = apiResponse.headers['content-security-policy'] || '';
  assert(
    !/form-action[^;]*\bhttps:/.test(apiCsp),
    `the relaxed form-action has leaked onto the API: ${apiCsp}`
  );

  console.log('BOOT TEST PASSED: app loaded, checkout CSP allows Razorpay checkout.js and the netbanking POST,');
  console.log('                  and the relaxed policy does not leak to other paths.');
  console.log('Checkout CSP:', csp);
  console.log('Default CSP: ', homeCsp);
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
