const OpenAI = require('openai');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

/** Gemini exposes an OpenAI-compatible endpoint that supports tool calling
 * and image input, which makes it the one provider that can serve as both
 * AI_PROVIDER and AI_VISION_PROVIDER on a single key. */
function createGeminiProvider({ apiKey, model, timeoutMs }) {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    timeout: Number(timeoutMs) || 30000,
  });
  return createOpenAICompatibleProvider({
    name: 'gemini',
    client,
    model,
    defaultModel: 'gemini-3.5-flash-lite',
  });
}

module.exports = { createGeminiProvider };
