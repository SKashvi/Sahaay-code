/* Return photo scoring.
 *
 * Scores a return photo against the reason the customer gave, so a reviewer
 * can triage a queue at a glance instead of opening every image.
 *
 * The score is ADVICE. Nothing in this codebase reads ai_verdict to approve,
 * reject, or refund anything. A human still clicks approve, which is the
 * whole point of the propose-and-approve design.
 *
 * Configured separately from the chat model because the cheap text models
 * cannot see: Groq's gpt-oss-20b and every DeepSeek model have no image
 * input at all. Leave AI_VISION_PROVIDER blank to skip scoring entirely,
 * which is a supported configuration, not a degraded one.
 */

const { env } = require('../../config/env');
const db = require('../db');
const { logError } = require('../errorLog');
const { isOwnUploadUrl } = require('../storage');

const VISION_CAPABLE = ['gemini', 'openai', 'anthropic'];
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const SYSTEM_PROMPT = [
  'You assess photographs attached to online store return requests.',
  'You are helping a human reviewer triage a queue. You are not deciding anything.',
  '',
  'Given the stated reason and the photo, answer only with JSON:',
  '{"score": 0-100, "verdict": "SUPPORTS" | "UNCLEAR" | "CONTRADICTS", "reasoning": "one sentence"}',
  '',
  'score is how well the photo supports the stated reason.',
  'Use UNCLEAR for a blurry, dark, cropped, or unrelated photo rather than guessing.',
  'Never accuse anyone of fraud. Describe what the image does or does not show.',
  'Output the JSON object and nothing else, with no code fences.',
].join('\n');

function visionConfigured() {
  return Boolean(env.AI_VISION_PROVIDER && env.AI_VISION_API_KEY && VISION_CAPABLE.includes(env.AI_VISION_PROVIDER));
}

async function fetchImage(url) {
  // Only URLs this server issued are ever fetched. Without this check the
  // scorer would follow any URL that reached the database, which is a
  // request-forgery hole pointed at the internal network.
  if (!isOwnUploadUrl(url)) throw new Error('Refusing to fetch a photo this server did not issue');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Could not fetch photo: ${response.status}`);
  const contentType = (response.headers.get('content-type') || '').split(';')[0].trim();
  if (!/^image\/(jpeg|png|webp)$/.test(contentType)) throw new Error(`Unexpected photo type: ${contentType}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new Error('Photo is too large to score');
  return { base64: buffer.toString('base64'), mimeType: contentType };
}

async function callAnthropic({ base64, mimeType, prompt, model, apiKey }) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: model || 'claude-sonnet-5',
      max_tokens: 300,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: base64 } },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw Object.assign(new Error(`Vision request failed: ${response.status} ${detail.slice(0, 200)}`), { status: response.status });
  }
  const body = await response.json();
  return (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
}

async function callOpenAICompatible({ base64, mimeType, prompt, model, apiKey, baseURL, defaultModel }) {
  const OpenAI = require('openai');
  const client = new OpenAI({ apiKey, baseURL, timeout: 30000 });
  const response = await client.chat.completions.create({
    model: model || defaultModel,
    max_tokens: 300,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
        ],
      },
    ],
  });
  return (response.choices && response.choices[0] && response.choices[0].message && response.choices[0].message.content) || '';
}

/** Models wrap JSON in prose or code fences often enough that this has to be
 * tolerant. An unparseable answer is a failed score, never a guessed one. */
function parseVerdict(raw) {
  const text = String(raw || '').replace(/```json|```/g, '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('Vision model did not return JSON');
  const parsed = JSON.parse(text.slice(start, end + 1));
  const score = Number(parsed.score);
  const verdict = String(parsed.verdict || '').toUpperCase();
  if (!Number.isFinite(score) || !['SUPPORTS', 'UNCLEAR', 'CONTRADICTS'].includes(verdict)) {
    throw new Error('Vision model returned an unusable verdict');
  }
  return {
    score: Math.max(0, Math.min(100, Math.round(score))),
    verdict,
    reasoning: String(parsed.reasoning || '').slice(0, 500),
  };
}

/**
 * @returns { score, verdict, reasoning, model } or null when scoring is off
 *          or failed. A null is not an error the customer ever sees.
 */
async function scorePhoto({ photoUrl, reason, description }) {
  if (!photoUrl || !visionConfigured()) return null;

  const provider = env.AI_VISION_PROVIDER;
  const model = env.AI_VISION_MODEL || null;
  const apiKey = env.AI_VISION_API_KEY;
  const prompt = [
    `Stated reason: ${reason || 'not given'}`,
    description ? `Customer's description: ${description}` : '',
    'Does the photo support that reason?',
  ].filter(Boolean).join('\n');

  try {
    const image = await fetchImage(photoUrl);
    let raw;
    if (provider === 'anthropic') {
      raw = await callAnthropic({ ...image, prompt, model, apiKey });
    } else if (provider === 'gemini') {
      raw = await callOpenAICompatible({
        ...image, prompt, model, apiKey,
        baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
        defaultModel: 'gemini-3.5-flash',
      });
    } else {
      raw = await callOpenAICompatible({ ...image, prompt, model, apiKey, baseURL: undefined, defaultModel: 'gpt-4o-mini' });
    }
    const verdict = parseVerdict(raw);
    return { ...verdict, model: model || provider };
  } catch (err) {
    await logError({
      source: 'vision',
      message: 'Return photo scoring failed',
      detail: err.message,
      context: { provider, model: model || provider },
    });
    return null;
  }
}

/**
 * Scores in the background and writes the result onto a pending_actions or
 * return_requests row. Fire and forget: a slow or failed vision call must
 * never delay or fail the customer's return submission.
 */
function scoreInBackground({ table, id, photoUrl, reason, description }) {
  if (!photoUrl || !visionConfigured()) return;
  const allowed = { pending_actions: 'pending_actions', return_requests: 'return_requests' };
  const target = allowed[table];
  if (!target) return;

  setImmediate(async () => {
    const result = await scorePhoto({ photoUrl, reason, description });
    if (!result) return;
    try {
      await db.query(
        `UPDATE ${target} SET ai_score = $2, ai_verdict = $3, ai_reasoning = $4, ai_model = $5 WHERE id = $1`,
        [id, result.score, result.verdict, result.reasoning, result.model]
      );
    } catch (err) {
      await logError({ source: 'vision', message: 'Could not store photo score', detail: err.message });
    }
  });
}

module.exports = { scorePhoto, scoreInBackground, visionConfigured, parseVerdict, VISION_CAPABLE };
