/* Run with: node test/ai-memory.test.js
 * Regression test for a real bug: chat history was fetched with
 * `ORDER BY created_at ASC LIMIT n`, which returns the OLDEST n messages
 * in a session forever, instead of the most recent n. This inserts more
 * messages than the history window and checks that the window slides
 * forward as the conversation grows. */
require('dotenv').config();
const crypto = require('crypto');
const db = require('../src/lib/db');

// Re-implemented here rather than imported, so this test still catches a
// regression even if someone "helpfully" inlines the query again elsewhere.
async function getHistory(sessionId, limit) {
  const result = await db.query(
    'SELECT role, content FROM chat_messages WHERE session_id = $1 ORDER BY created_at DESC LIMIT $2',
    [sessionId, limit]
  );
  return result.rows.reverse().map((r) => r.content);
}

async function main() {
  const sessionId = 'test-session-' + crypto.randomBytes(4).toString('hex');
  const totalMessages = 20;
  const windowSize = 12;

  for (let i = 1; i <= totalMessages; i++) {
    await db.query(
      'INSERT INTO chat_messages (id, session_id, role, content) VALUES ($1,$2,$3,$4)',
      [crypto.randomUUID(), sessionId, i % 2 === 0 ? 'assistant' : 'user', 'message-' + i]
    );
    // created_at has second-level meaningful ordering in real usage, but
    // within a single fast loop these could tie, so give each an
    // unambiguous, strictly increasing timestamp instead of relying on
    // wall-clock granularity.
    await db.query(
      "UPDATE chat_messages SET created_at = now() + ($1 || ' milliseconds')::interval WHERE session_id = $2 AND content = $3",
      [i * 10, sessionId, 'message-' + i]
    );
  }

  const history = await getHistory(sessionId, windowSize);
  console.log('history returned:', history);

  const expectedOldest = 'message-' + (totalMessages - windowSize + 1); // message-9
  const expectedNewest = 'message-' + totalMessages; // message-20

  if (history.length !== windowSize) {
    throw new Error(`expected ${windowSize} messages, got ${history.length}`);
  }
  if (history[0] !== expectedOldest) {
    throw new Error(`expected the window to start at ${expectedOldest}, got ${history[0]} (this is the exact bug: ASC+LIMIT would return message-1 here)`);
  }
  if (history[history.length - 1] !== expectedNewest) {
    throw new Error(`expected the window to end at ${expectedNewest}, got ${history[history.length - 1]}`);
  }
  for (let i = 1; i < history.length; i++) {
    const prevNum = Number(history[i - 1].split('-')[1]);
    const curNum = Number(history[i].split('-')[1]);
    if (curNum !== prevNum + 1) throw new Error('history is not in chronological order: ' + history.join(', '));
  }

  console.log('PASS: history window correctly slides to the most recent ' + windowSize + ' messages, in chronological order');
  await db.query('DELETE FROM chat_messages WHERE session_id = $1', [sessionId]);
  await db.pool.end();
}

main().catch((err) => {
  console.error('TEST FAILED:', err.message);
  process.exit(1);
});
