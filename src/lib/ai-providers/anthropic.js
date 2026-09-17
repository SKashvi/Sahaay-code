/* Anthropic is the one provider here that does not speak the OpenAI wire
 * format, so it maps the neutral message shape itself. Two differences that
 * matter and are easy to get wrong:
 *
 *   1. Tool results are not their own role. They go back as a USER message
 *      containing tool_result content blocks. Several results from one
 *      assistant turn must be merged into a single user message, not sent
 *      as one message each.
 *   2. An assistant turn that called tools is a content block array mixing
 *      optional text with tool_use blocks, not a separate tool_calls field.
 */

const DEFAULT_MODEL = 'claude-sonnet-5';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

function toAnthropicMessages(messages) {
  const out = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      };
      const previous = out[out.length - 1];
      // Merge into the preceding user message when that message is itself a
      // run of tool results, so a turn with three tool calls produces one
      // user message with three blocks.
      if (previous && previous.role === 'user' && Array.isArray(previous.content)
        && previous.content.every((c) => c.type === 'tool_result')) {
        previous.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length) {
      const content = [];
      if (message.content) content.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments || {} });
      }
      out.push({ role: 'assistant', content });
      continue;
    }

    out.push({ role: message.role, content: [{ type: 'text', text: message.content }] });
  }
  return out;
}

function toAnthropicTools(tools) {
  if (!tools || !tools.length) return undefined;
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function createAnthropicProvider({ apiKey, model }) {
  return {
    name: 'anthropic',
    async complete({ systemPrompt, messages, tools, maxTokens }) {
      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify({
          model: model || DEFAULT_MODEL,
          max_tokens: maxTokens,
          system: systemPrompt,
          messages: toAnthropicMessages(messages),
          tools: toAnthropicTools(tools),
        }),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        // The status is attached so the fallback logic in index.js can tell
        // a retryable 429/5xx apart from a bad key, which it must not retry.
        throw Object.assign(new Error('Anthropic request failed: ' + response.status + ' ' + detail.slice(0, 300)), {
          status: response.status,
        });
      }

      const body = await response.json();
      const blocks = Array.isArray(body.content) ? body.content : [];

      const text = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();

      const toolCalls = blocks
        .filter((block) => block.type === 'tool_use')
        .map((block) => ({ id: block.id, name: block.name, arguments: block.input || {} }));

      if (!text && !toolCalls.length) throw new Error('Anthropic returned an empty response');

      return { text, toolCalls };
    },
  };
}

module.exports = { createAnthropicProvider, toAnthropicMessages, toAnthropicTools };
