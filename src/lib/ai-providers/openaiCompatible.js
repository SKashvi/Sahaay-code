/* Four of the five providers (openai, deepseek, gemini, groq) speak the
 * OpenAI chat completions wire format, they differ only by base URL and
 * default model. Rather than four near-identical copies of the tool calling
 * plumbing, they all build on this one factory. Anthropic has its own
 * message and tool schema and lives in anthropic.js.
 *
 * Contract every provider in this folder honours:
 *
 *   complete({ systemPrompt, messages, tools, maxTokens })
 *     -> { text: string, toolCalls: [{ id, name, arguments, extraContent? }] }
 *
 * where `messages` is the neutral shape defined in src/lib/agent/loop.js:
 *   { role: 'user',      content }
 *   { role: 'assistant', content, toolCalls }
 *   { role: 'tool',      toolCallId, name, content }
 */

function toOpenAIMessages(systemPrompt, messages) {
  const out = [{ role: 'system', content: systemPrompt }];

  for (const message of messages) {
    if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content:
          typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content),
      });
      continue;
    }

    if (message.role === 'assistant' && message.toolCalls && message.toolCalls.length) {
      out.push({
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments || {}),
          },

          // Gemini 3 returns a required thought signature inside
          // extra_content.google.thought_signature. Preserve it when
          // sending the assistant tool call back on the next turn.
          ...(call.extraContent
            ? { extra_content: call.extraContent }
            : {}),
        })),
      });
      continue;
    }

    out.push({ role: message.role, content: message.content });
  }

  return out;
}

function toOpenAITools(tools) {
  if (!tools || !tools.length) return undefined;

  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/** Arguments arrive as a JSON string. A model can produce a malformed one,
 * and that must degrade into "this tool call failed" rather than throwing
 * out of the whole chat request. */
function parseArguments(raw) {
  if (!raw) return {};

  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return { __parseError: true };
  }
}

function createOpenAICompatibleProvider({
  name,
  client,
  defaultModel,
  model,
}) {
  return {
    name,

    async complete({
      systemPrompt,
      messages,
      tools,
      maxTokens,
    }) {
      const response = await client.chat.completions.create({
        model: model || defaultModel,
        messages: toOpenAIMessages(systemPrompt, messages),
        tools: toOpenAITools(tools),
        max_tokens: maxTokens,
      });

      const choice = response.choices && response.choices[0];
      const raw = choice && choice.message;

      if (!raw) {
        throw new Error(`${name} returned no message`);
      }

      const toolCalls = (raw.tool_calls || [])
        .filter(
          (call) =>
            call.function &&
            call.function.name
        )
        .map((call) => ({
          id: call.id,
          name: call.function.name,
          arguments: parseArguments(call.function.arguments),

          // Preserve Gemini's thought signature so it can be sent back
          // with the assistant tool call on the next request.
          ...(call.extra_content
            ? { extraContent: call.extra_content }
            : {}),
        }));

      const text = (raw.content || '').trim();

      // An empty reply is only an error when the model also asked for no
      // tools. Mid-loop, "no text, just tool calls" is the normal case.
      if (!text && !toolCalls.length) {
        throw new Error(`${name} returned an empty response`);
      }

      return {
        text,
        toolCalls,
      };
    },
  };
}

module.exports = {
  createOpenAICompatibleProvider,
  toOpenAIMessages,
  toOpenAITools,
  parseArguments,
};
