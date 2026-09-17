const OpenAI = require('openai');
const { createOpenAICompatibleProvider } = require('./openaiCompatible');

function createOpenAIProvider({ apiKey, model, timeoutMs }) {
  const client = new OpenAI({ apiKey, timeout: Number(timeoutMs) || 30000 });
  return createOpenAICompatibleProvider({
    name: 'openai',
    client,
    model,
    defaultModel: 'gpt-4o-mini',
  });
}

module.exports = { createOpenAIProvider };
