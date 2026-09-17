/* Run with: node test/agent-loop.test.js
 *
 * Covers the two pieces of the agent that have no business touching a
 * database or a real provider: the tool calling loop, and the translation
 * between the neutral message shape and each vendor's wire format. Runs with
 * no DATABASE_URL and no API keys.
 */

const assert = require('assert');
const { runAgent } = require('../src/lib/agent/loop');
const { toOpenAIMessages } = require('../src/lib/ai-providers/openaiCompatible');
const { toAnthropicMessages } = require('../src/lib/ai-providers/anthropic');

function scriptedClient(script) {
  const seen = [];
  return {
    seen,
    calls: () => seen.length,
    async complete(args) {
      seen.push(args);
      const next = script[seen.length - 1];
      if (!next) throw new Error('client called more times than the script allows');
      return next;
    },
  };
}

function fakeToolset(handlers) {
  const executed = [];
  return {
    executed,
    definitions: Object.keys(handlers).map((name) => ({
      name,
      description: name,
      parameters: { type: 'object', properties: {}, required: [] },
    })),
    async execute(name, args, ctx) {
      executed.push({ name, args, ctx });
      return handlers[name](args, ctx);
    },
  };
}

async function testSingleToolThenAnswer() {
  const client = scriptedClient([
    { text: '', toolCalls: [{ id: 'c1', name: 'search_catalog', arguments: { query: 'kurta' } }] },
    { text: 'We have two kurtas in stock.', toolCalls: [] },
  ]);
  const toolset = fakeToolset({
    search_catalog: async () => ({
      result: { count: 2 },
      blocks: [{ type: 'products', items: [{ id: 'p1' }, { id: 'p2' }] }],
    }),
  });

  const out = await runAgent({
    client,
    toolset,
    ctx: { sessionId: 's1', customer: null },
    systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'show me kurtas' }],
  });

  assert.strictEqual(out.text, 'We have two kurtas in stock.');
  assert.deepStrictEqual(out.steps, ['search_catalog']);
  assert.strictEqual(out.blocks.length, 1);
  assert.strictEqual(out.blocks[0].type, 'products');

  // The second call must carry the assistant tool call turn and the tool
  // result, otherwise the model is answering with no idea what came back.
  const secondCall = client.seen[1];
  assert.strictEqual(secondCall.messages.length, 3);
  assert.strictEqual(secondCall.messages[1].role, 'assistant');
  assert.strictEqual(secondCall.messages[2].role, 'tool');
  assert.strictEqual(secondCall.messages[2].toolCallId, 'c1');
  console.log('  ok  single tool call, then an answer');
}

async function testSeveralToolsInOneTurn() {
  const client = scriptedClient([
    {
      text: '',
      toolCalls: [
        { id: 'a', name: 'search_catalog', arguments: {} },
        { id: 'b', name: 'check_offers', arguments: {} },
      ],
    },
    { text: 'Here you go.', toolCalls: [] },
  ]);
  const toolset = fakeToolset({
    search_catalog: async () => ({ result: { ok: 1 }, blocks: [{ type: 'products', items: [] }] }),
    check_offers: async () => ({ result: { ok: 2 }, blocks: [{ type: 'offers', items: [] }] }),
  });

  const out = await runAgent({
    client, toolset, ctx: {}, systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'what is on sale' }],
  });

  assert.deepStrictEqual(out.steps, ['search_catalog', 'check_offers']);
  assert.deepStrictEqual(out.blocks.map((b) => b.type), ['products', 'offers']);
  console.log('  ok  two tools in one turn, both results fed back');
}

async function testIterationCapWithholdsTools() {
  // A model that would keep calling tools forever. The loop must stop and
  // still produce text rather than ending the turn with an empty bubble.
  const alwaysCallsTools = {
    calls: 0,
    lastArgs: null,
    async complete(args) {
      this.calls++;
      this.lastArgs = args;
      if (args.tools === undefined) return { text: 'Final answer without tools.', toolCalls: [] };
      return { text: '', toolCalls: [{ id: 'x' + this.calls, name: 'search_catalog', arguments: {} }] };
    },
  };
  const toolset = fakeToolset({ search_catalog: async () => ({ result: {}, blocks: [] }) });

  const out = await runAgent({
    client: alwaysCallsTools, toolset, ctx: {}, systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'loop forever' }],
    maxIterations: 3,
  });

  assert.strictEqual(alwaysCallsTools.calls, 3, 'must stop at maxIterations');
  assert.strictEqual(alwaysCallsTools.lastArgs.tools, undefined, 'tools must be withheld on the last pass');
  assert.strictEqual(out.text, 'Final answer without tools.');
  assert.strictEqual(toolset.executed.length, 2, 'no tools run on the final, tool-free pass');
  console.log('  ok  iteration cap withholds tools and still answers');
}

async function testFailingToolDoesNotKillTheTurn() {
  const client = scriptedClient([
    { text: '', toolCalls: [{ id: 'c1', name: 'boom', arguments: {} }] },
    { text: 'I could not check that right now.', toolCalls: [] },
  ]);
  // Mirrors what tools.execute does with a thrown error: it returns an error
  // RESULT rather than throwing, so the loop keeps going.
  const toolset = fakeToolset({
    boom: async () => ({ result: { error: 'tool_failed' }, blocks: [] }),
  });

  const out = await runAgent({
    client, toolset, ctx: {}, systemPrompt: 'sys',
    messages: [{ role: 'user', content: 'where is my order' }],
  });
  assert.strictEqual(out.text, 'I could not check that right now.');
  console.log('  ok  a failing tool degrades into an answer, not an exception');
}

function testOpenAIMapping() {
  const mapped = toOpenAIMessages('sys', [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_catalog', arguments: { query: 'x' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'search_catalog', content: '{"count":1}' },
  ]);

  assert.strictEqual(mapped[0].role, 'system');
  assert.strictEqual(mapped[2].tool_calls[0].type, 'function');
  assert.strictEqual(mapped[2].tool_calls[0].function.name, 'search_catalog');
  // Arguments must be a JSON string, not an object, or the API rejects it.
  assert.strictEqual(typeof mapped[2].tool_calls[0].function.arguments, 'string');
  assert.strictEqual(mapped[3].role, 'tool');
  assert.strictEqual(mapped[3].tool_call_id, 'c1');
  console.log('  ok  openai mapping: tool_calls and tool results');
}

function testAnthropicMapping() {
  const mapped = toAnthropicMessages([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: 'checking',
      toolCalls: [
        { id: 'c1', name: 'search_catalog', arguments: {} },
        { id: 'c2', name: 'check_offers', arguments: {} },
      ],
    },
    { role: 'tool', toolCallId: 'c1', name: 'search_catalog', content: '{}' },
    { role: 'tool', toolCallId: 'c2', name: 'check_offers', content: '{}' },
  ]);

  assert.strictEqual(mapped[1].role, 'assistant');
  assert.strictEqual(mapped[1].content[0].type, 'text');
  assert.strictEqual(mapped[1].content[1].type, 'tool_use');

  // Both tool results must collapse into ONE user message with two blocks.
  // Sending them as two separate messages is rejected by the API.
  assert.strictEqual(mapped.length, 3, 'tool results must merge into one user message');
  assert.strictEqual(mapped[2].role, 'user');
  assert.strictEqual(mapped[2].content.length, 2);
  assert.strictEqual(mapped[2].content[0].tool_use_id, 'c1');
  assert.strictEqual(mapped[2].content[1].tool_use_id, 'c2');
  console.log('  ok  anthropic mapping: tool_use blocks and merged tool_result');
}

async function main() {
  console.log('agent loop');
  await testSingleToolThenAnswer();
  await testSeveralToolsInOneTurn();
  await testIterationCapWithholdsTools();
  await testFailingToolDoesNotKillTheTurn();
  console.log('provider mapping');
  testOpenAIMapping();
  testAnthropicMapping();
  console.log('\nAll agent loop tests passed.');
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
