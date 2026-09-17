const OpenAI = require('openai');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

/** Groq is the cheapest and fastest option here and supports tool calling.
 * It has no image input on the text models, so like DeepSeek it can be
 * AI_PROVIDER but never AI_VISION_PROVIDER. */
function createGroqProvider({ apiKey, model, timeoutMs }) {
  const client = new OpenAI({
    apiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    timeout: Number(timeoutMs) || 30000,
  });
  return createOpenAICompatibleProvider({
    name: 'groq',
    client,
    model,
    defaultModel: 'openai/gpt-oss-20b',
  });
}

module.exports = { createGroqProvider };
