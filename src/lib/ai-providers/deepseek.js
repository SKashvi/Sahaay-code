const OpenAI = require('openai');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

/**
 * DeepSeek's API is intentionally OpenAI-compatible (same request and
 * response shape, including tool calling), so this is the official openai
 * SDK pointed at DeepSeek's base URL. Current model ids are
 * deepseek-v4-flash (fast, inexpensive, the sensible default for a support
 * widget) and deepseek-v4-pro. The older deepseek-chat / deepseek-reasoner
 * names were retired.
 *
 * Note for the vision scoring work: DeepSeek has no image input, so it can
 * be AI_PROVIDER but never AI_VISION_PROVIDER.
 */
function createDeepSeekProvider({ apiKey, model, timeoutMs }) {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.deepseek.com',
    timeout: Number(timeoutMs) || 30000,
  });
  return createOpenAICompatibleProvider({
    name: 'deepseek',
    client,
    model,
    defaultModel: 'deepseek-v4-flash',
  });
}

module.exports = { createDeepSeekProvider };
