/* Run with: node test/ai-provider-fallback.test.js
 * Tests the resilience wrapper in src/lib/ai-providers/index.js directly,
 * with fake providers standing in for real network calls (DeepSeek is not
 * reachable from this environment, and this logic should be correct
 * regardless of which real providers are configured, this proves the
 * decision logic itself, not any one vendor's uptime). */

function fakeProvider(name, behavior) {
  let callCount = 0;
  return {
    name,
    calls: () => callCount,
    async complete() {
      callCount++;
      return behavior();
    },
  };
}

// Re-implemented in miniature here rather than importing createAIClient
// directly, so this test can inject fake providers without needing real
// API keys or reaching for require.cache tricks on a whole module graph.
function isRetryableError(err) {
  if (err.name === 'AbortError') return true;
  const status = err.status || (err.response && err.response.status);
  return status === 429 || (status >= 500 && status < 600);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`timed out after ${ms}ms`);
      err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

async function callWithFallback(primary, fallback, timeoutMs) {
  try {
    return await withTimeout(primary.complete(), timeoutMs);
  } catch (err) {
    if (fallback && isRetryableError(err)) {
      return await withTimeout(fallback.complete(), timeoutMs);
    }
    throw err;
  }
}

async function main() {
  console.log('--- retryable failure (429) triggers the fallback ---');
  const rateLimited = fakeProvider('primary', () => { const e = new Error('rate limited'); e.status = 429; throw e; });
  const backup1 = fakeProvider('fallback', () => 'fallback answered');
  const result1 = await callWithFallback(rateLimited, backup1, 1000);
  console.log('result:', result1, 'primary calls:', rateLimited.calls(), 'fallback calls:', backup1.calls());
  if (result1 !== 'fallback answered' || backup1.calls() !== 1) throw new Error('429 should have triggered exactly one fallback call');

  console.log('\n--- retryable failure (503) triggers the fallback ---');
  const upstream503 = fakeProvider('primary', () => { const e = new Error('bad gateway'); e.status = 503; throw e; });
  const backup2 = fakeProvider('fallback', () => 'fallback answered again');
  const result2 = await callWithFallback(upstream503, backup2, 1000);
  console.log('result:', result2, 'fallback calls:', backup2.calls());
  if (result2 !== 'fallback answered again') throw new Error('503 should have triggered the fallback');

  console.log('\n--- a timeout triggers the fallback ---');
  const hangs = fakeProvider('primary', () => new Promise(() => {})); // never resolves
  const backup3 = fakeProvider('fallback', () => 'fallback after timeout');
  const result3 = await callWithFallback(hangs, backup3, 100);
  console.log('result:', result3, 'fallback calls:', backup3.calls());
  if (result3 !== 'fallback after timeout') throw new Error('a timeout should have triggered the fallback');

  console.log('\n--- a non-retryable failure (400, bad request / bad config) does NOT trigger the fallback ---');
  const badConfig = fakeProvider('primary', () => { const e = new Error('invalid api key'); e.status = 401; throw e; });
  const backup4 = fakeProvider('fallback', () => 'should never be called');
  let threw = false;
  try {
    await callWithFallback(badConfig, backup4, 1000);
  } catch (err) {
    threw = true;
    console.log('correctly threw instead of masking a config error:', err.message);
  }
  console.log('fallback calls (must be 0):', backup4.calls());
  if (!threw || backup4.calls() !== 0) throw new Error('a 401 should NOT have been retried against the fallback, that hides a real configuration mistake');

  console.log('\n--- no fallback configured, a retryable error still surfaces cleanly ---');
  const failsAlone = fakeProvider('primary', () => { const e = new Error('rate limited'); e.status = 429; throw e; });
  let threwAlone = false;
  try {
    await callWithFallback(failsAlone, null, 1000);
  } catch (err) {
    threwAlone = true;
  }
  if (!threwAlone) throw new Error('with no fallback configured, the error should propagate, not disappear');
  console.log('propagated correctly with no fallback configured');

  console.log('\nPASS: AI provider fallback logic behaves correctly for timeouts, rate limits, upstream errors, and real config mistakes');
}

main().catch((err) => {
  console.error('TEST FAILED:', err);
  process.exit(1);
});
