/* The tool calling loop.
 *
 * Kept free of database and provider imports on purpose: everything it needs
 * arrives as an argument. That is what lets test/agent-loop.test.js drive it
 * with a fake client and a fake toolset, with no API key and no database.
 *
 * Neutral message shape used throughout (providers translate it):
 *   { role: 'user',      content }
 *   { role: 'assistant', content, toolCalls: [{ id, name, arguments }] }
 *   { role: 'tool',      toolCallId, name, content }
 */

const DEFAULT_MAX_ITERATIONS = 4;

/* search_catalog and suggest_add_ons both emit a products block, and blocks
 * accumulates across every iteration of the loop, so one turn can end up
 * carrying several of them and the widget renders the same card grid twice.
 * They are merged into the first one, in place, so everything else keeps the
 * position it was produced in. Items are de-duplicated by id, because the
 * add-ons call routinely returns something the search already showed.
 */
function collapseProductBlocks(blocks) {
  const firstIndex = blocks.findIndex((block) => block && block.type === 'products');
  if (firstIndex === -1) return blocks;

  const items = [];
  const seen = new Set();
  for (const block of blocks) {
    if (!block || block.type !== 'products') continue;
    for (const item of block.items || []) {
      const key = item && item.id != null ? String(item.id) : JSON.stringify(item);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(item);
    }
  }

  const merged = { ...blocks[firstIndex], items };
  return blocks.reduce((out, block, index) => {
    if (block && block.type === 'products') {
      if (index === firstIndex) out.push(merged);
      return out;
    }
    out.push(block);
    return out;
  }, []);
}

/**
 * @returns {{ text, blocks, steps }} steps is the tool names called, in
 * order, which is what the admin conversations view will show later.
 */
async function runAgent({
  client,
  toolset,
  ctx,
  systemPrompt,
  messages,
  maxTokens = 400,
  maxIterations = DEFAULT_MAX_ITERATIONS,
}) {
  const working = messages.slice();
  const blocks = [];
  const steps = [];

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const isLastIteration = iteration === maxIterations - 1;

    const response = await client.complete({
      systemPrompt,
      messages: working,
      // On the final iteration the tools are withheld, which forces the
      // model to answer with what it already has. Without this a model that
      // keeps calling tools would end the turn with no text at all and the
      // customer would see an empty bubble.
      tools: isLastIteration ? undefined : toolset.definitions,
      maxTokens,
    });

    const toolCalls = response.toolCalls || [];
    if (!toolCalls.length) {
      return { text: response.text || '', blocks: collapseProductBlocks(blocks), steps };
    }

    working.push({ role: 'assistant', content: response.text || '', toolCalls });

    // Sequential rather than parallel: these tools hit one Postgres pool and
    // several of them write. Ordered execution keeps the failure mode simple
    // and the pool from being hammered by a model that asks for six lookups
    // in one turn.
    for (const call of toolCalls) {
      const outcome = await toolset.execute(call.name, call.arguments, ctx);
      steps.push(call.name);
      if (outcome.blocks && outcome.blocks.length) blocks.push(...outcome.blocks);
      working.push({
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: JSON.stringify(outcome.result),
      });
    }
  }

  // Only reachable if the final iteration still produced no text, which
  // means the provider ignored the withheld tools. Better a plain sentence
  // than an empty bubble.
  return {
    text: 'Let me get someone from the team to pick this up with you.',
    blocks: collapseProductBlocks(blocks),
    steps,
  };
}

module.exports = { runAgent, DEFAULT_MAX_ITERATIONS };
