const { createDeepSeekProvider } = require('./deepseek');
const { createOpenAIProvider } = require('./openai');
const { createAnthropicProvider } = require('./anthropic');
const { createGeminiProvider } = require('./gemini');
const { createGroqProvider } = require('./groq');

const FACTORIES = {
  deepseek: createDeepSeekProvider,
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  gemini: createGeminiProvider,
  groq: createGroqProvider,
};

/** The rest of the app calls ai.reply(...) and never knows or cares which
 * of these ran. Adding a new provider later means one new file in this
 * folder plus one new entry here, nothing else in the app changes. */
function buildProvider(providerName, apiKey, model, timeoutMs) {
  const factory = FACTORIES[providerName];
  if (!factory) {
    throw new Error(`Unknown AI provider "${providerName}". Supported: ${Object.keys(FACTORIES).join(', ')}`);
  }
  return factory({ apiKey, model, timeoutMs });
}

function isRetryableError(err) {
  // Covers: request timeout (our own AbortError below), rate limiting,
  // and transient upstream failures. Does not cover 400-class errors like
  // an invalid API key or a malformed request, retrying those against a
  // second provider would not help and would hide a real configuration
  // problem.
  if (err.name === 'AbortError') return true;
  const status = err.status || (err.response && err.response.status);
  return status === 429 || (status >= 500 && status < 600);
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`AI provider timed out after ${ms}ms`);
      err.name = 'AbortError';
      reject(err);
    }, ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

/**
 * Builds the resilient AI client for this app: a primary provider, an
 * optional fallback used only for retryable failures (timeout, rate
 * limit, upstream 5xx), and a hard timeout on every call so one slow
 * provider can never hang a chat request indefinitely.
 */
function createAIClient(env) {
  const timeoutMs = Number(env.AI_TIMEOUT_MS) || 15000;
  const primary = buildProvider(env.AI_PROVIDER, env.AI_API_KEY, env.AI_MODEL, timeoutMs);
  const fallback = env.AI_FALLBACK_PROVIDER
    ? buildProvider(env.AI_FALLBACK_PROVIDER, env.AI_FALLBACK_API_KEY, env.AI_FALLBACK_MODEL)
    : null;

  return {
    async complete(args) {
      try {
        return await withTimeout(primary.complete(args), timeoutMs);
      } catch (err) {
        console.error(`AI provider "${primary.name}" failed:`, err.status || err.name || '', err.message);
        if (fallback && isRetryableError(err)) {
          console.error(`Falling back to "${fallback.name}"`);
          try {
            return await withTimeout(fallback.complete(args), timeoutMs);
          } catch (fallbackErr) {
            console.error(`Fallback provider "${fallback.name}" also failed:`, fallbackErr.status || fallbackErr.name || '', fallbackErr.message);
            throw fallbackErr;
          }
        }
        throw err;
      }
    },
  };
}

module.exports = { createAIClient };
