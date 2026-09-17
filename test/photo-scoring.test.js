/* Run with: node test/photo-scoring.test.js
 *
 * The parsing and refusal rules around return photo scoring. No database, no
 * API key, no network. The one thing this deliberately does NOT test is the
 * quality of a model's judgement, which is not a thing a unit test can
 * assert and not a thing the system relies on: the score is advice for a
 * human reviewer and nothing in the codebase reads it to approve anything.
 */

const assert = require('assert');
const { parseVerdict, visionConfigured, VISION_CAPABLE } = require('../src/lib/agent/photoScoring');

let failures = 0;
function check(name, condition) {
  if (condition) {
    console.log('  ok  ' + name);
  } else {
    failures++;
    console.log('  FAIL ' + name);
  }
}

function expectThrow(fn) {
  try {
    fn();
    return false;
  } catch (err) {
    return true;
  }
}

console.log('verdict parsing');

const clean = parseVerdict('{"score": 82, "verdict": "SUPPORTS", "reasoning": "The seam is visibly torn."}');
check('a clean JSON verdict parses', clean.score === 82 && clean.verdict === 'SUPPORTS');

// Models wrap JSON in fences and prose often enough that this has to be
// tolerant, or half of all scores would be lost to formatting.
const fenced = parseVerdict('```json\n{"score": 40, "verdict": "UNCLEAR", "reasoning": "Too dark to tell."}\n```');
check('a fenced verdict parses', fenced.score === 40 && fenced.verdict === 'UNCLEAR');

const chatty = parseVerdict('Here is my assessment:\n{"score": 10, "verdict": "CONTRADICTS", "reasoning": "Shows a different item."}\nHope that helps.');
check('a verdict wrapped in prose parses', chatty.score === 10 && chatty.verdict === 'CONTRADICTS');

// Out of range and unusable answers must fail closed. A guessed score would
// be worse than no score, because a reviewer would trust it.
const clamped = parseVerdict('{"score": 500, "verdict": "SUPPORTS", "reasoning": "x"}');
check('an out of range score is clamped to 100', clamped.score === 100);

const negative = parseVerdict('{"score": -20, "verdict": "SUPPORTS", "reasoning": "x"}');
check('a negative score is clamped to 0', negative.score === 0);

check('a non-JSON answer is rejected rather than guessed', expectThrow(() => parseVerdict('Looks fine to me')));
check('an unknown verdict word is rejected', expectThrow(() => parseVerdict('{"score": 50, "verdict": "MAYBE"}')));
check('a missing score is rejected', expectThrow(() => parseVerdict('{"verdict": "SUPPORTS"}')));
check('empty output is rejected', expectThrow(() => parseVerdict('')));

console.log('configuration');

// The whole reason vision is configured separately: the cheap text models
// cannot see. Shipping a deployment where AI_VISION_PROVIDER is groq would
// fail on every photo, so those providers are simply not accepted.
check('only image-capable providers are allowed', VISION_CAPABLE.every((p) => ['gemini', 'openai', 'anthropic'].includes(p)));
check('groq is not an accepted vision provider', !VISION_CAPABLE.includes('groq'));
check('deepseek is not an accepted vision provider', !VISION_CAPABLE.includes('deepseek'));
check('scoring is off when no vision provider is configured', visionConfigured() === Boolean(
  process.env.AI_VISION_PROVIDER && process.env.AI_VISION_API_KEY && VISION_CAPABLE.includes(process.env.AI_VISION_PROVIDER)
));

if (failures) {
  console.error(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll photo scoring tests passed.');
