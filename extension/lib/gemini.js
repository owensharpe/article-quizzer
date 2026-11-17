// https://ai.google.dev/api/generate-content

import { cleanModelId } from './storage.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
// An overloaded model can leave a request hanging for minutes, while another
// model may answer in seconds. Files such as PDFs take longer to read.
const TIME_LIMIT_MS = 45_000;
const FILE_TIME_LIMIT_MS = 120_000;

// detail holds what Gemini itself said, for showing in small print. timedOut
// marks a request that got no reply within the time limit.
export class AIError extends Error {
  constructor(
    message,
    { code = 'unknown', status = 0, retryAfterSec = null, detail = '', timedOut = false } = {},
  ) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.detail = detail;
    this.timedOut = timedOut;
  }
}

// Gemini 3+ takes thinkingLevel; older models reject it.
function acceptsThinkingLevel(modelId) {
  const match = /^gemini-(\d+)/.exec(modelId);
  return match ? Number(match[1]) >= 3 : modelId.endsWith('-latest');
}

// attachments: [{ mimeType, data }] with base64 data, such as a PDF.
export function buildRequestBody({ system, prompt, schema, thinkingLevel, attachments = [] }) {
  const generationConfig = { responseMimeType: 'application/json', responseJsonSchema: schema };
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
  const files = attachments.map(({ mimeType, data }) => ({ inlineData: { mimeType, data } }));
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [...files, { text: prompt }] }],
    generationConfig,
  };
}

export function timeLimit(attachments = []) {
  return attachments.length ? FILE_TIME_LIMIT_MS : TIME_LIMIT_MS;
}

// Overloads aren't retried here, since the caller may do better with another
// model first. timeoutMs limits each request.
export async function generateJSON({
  apiKey,
  model,
  system,
  prompt,
  schema,
  attachments = [],
  signal,
  timeoutMs = timeLimit(attachments),
  fetchImpl = fetch,
}) {
  const key = cleanKey(apiKey);
  if (!key) throw new AIError('Add your Gemini API key first.', { code: 'no_key' });
  const modelId = cleanModelId(model);
  if (!modelId) throw new AIError('Choose a Gemini model in Settings.', { code: 'bad_model' });

  const url = `${API_ROOT}/models/${encodeURIComponent(modelId)}:generateContent`;
  const attempt = (thinkingLevel) => {
    const body = buildRequestBody({ system, prompt, schema, attachments, thinkingLevel });
    return send(fetchImpl, url, key, body, withTimeLimit(signal, timeoutMs)).catch((err) => {
      throw err?.name === 'TimeoutError' ? timeoutError(modelId, timeoutMs) : err;
    });
  };
  // Low thinking keeps quizzes fast; the questions come straight from the text.
  const thinkingLevel = acceptsThinkingLevel(modelId) ? 'low' : null;
  let res = await attempt(thinkingLevel);
  if (res.status === 400 && thinkingLevel && /thinking/i.test(errorMessage(res.data))) {
    res = await attempt(null);
  }
  if (!res.ok) throw toAIError(res.status, res.data, modelId);
  return parseGenerateResponse(res.data);
}

// Checks a key without spending generation quota.
export async function testConnection({ apiKey, model, fetchImpl = fetch }) {
  const key = cleanKey(apiKey);
  const modelId = cleanModelId(model);
  let res;
  try {
    res = await fetchImpl(`${API_ROOT}/models/${encodeURIComponent(modelId)}`, {
      headers: { 'x-goog-api-key': key },
    });
  } catch {
    throw networkError();
  }
  if (res.ok) return true;
  throw toAIError(res.status, await res.json().catch(() => null), modelId);
}

// Only an outright rejection rules a key out: a network error, rate limit, or
// unavailable model says nothing about the key. Resolves with such an error, if any.
export async function checkKey({ apiKey, model, fetchImpl }) {
  try {
    await testConnection({ apiKey, model, fetchImpl });
    return null;
  } catch (err) {
    if (err.code === 'bad_key') throw err;
    return err;
  }
}

async function send(fetchImpl, url, apiKey, body, signal) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (stopped(err)) throw err;
    throw networkError();
  }
  // A cancel or the time limit can also land while the body is still arriving.
  const data = await res.json().catch((err) => {
    if (stopped(err)) throw err;
    return null;
  });
  return { ok: res.ok, status: res.status, data };
}

// Aborts when the caller cancels or the time runs out, whichever comes first.
function withTimeLimit(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (AbortSignal.any) return AbortSignal.any([signal, timeout]);
  const controller = new AbortController();
  for (const source of [signal, timeout]) {
    if (source.aborted) controller.abort(source.reason);
    else source.addEventListener('abort', () => controller.abort(source.reason), { once: true });
  }
  return controller.signal;
}

// Cancelled or out of time, as opposed to failing on its own.
function stopped(err) {
  return err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

// Counts as a busy model, so the next model gets a turn.
function timeoutError(modelId, ms) {
  return new AIError('Gemini took too long to answer. Try again in a moment.', {
    code: 'server',
    detail: `No response from ${modelId} within ${Math.round(ms / 1000)} seconds`,
    timedOut: true,
  });
}

// Keys copied from a web page or document can pick up invisible characters,
// which fetch refuses in a header and reports like a network failure.
function cleanKey(apiKey) {
  const key = String(apiKey ?? '').replace(/[\s\p{Cf}]/gu, '');
  if (/[^\x20-\x7e]/.test(key)) {
    throw new AIError(
      'That API key contains characters that cannot appear in a key. Copy it again from Google AI Studio.',
      { code: 'bad_key' },
    );
  }
  return key;
}

export function parseGenerateResponse(data) {
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new AIError(`Gemini wouldn't process this text (${humanize(blockReason)}).`, { code: 'blocked' });
  }
  const candidate = data?.candidates?.[0];
  const finish = candidate?.finishReason;
  const text = (candidate?.content?.parts ?? [])
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('')
    .trim();

  if (finish === 'MAX_TOKENS') {
    throw new AIError('The response was cut off before it finished. Try fewer questions.', {
      code: 'truncated',
    });
  }
  if (finish === 'RECITATION') {
    throw new AIError('Gemini stopped because its answer quoted the source too closely. Try again.', {
      code: 'recitation',
    });
  }
  if (!text) {
    if (finish && finish !== 'STOP') {
      throw new AIError(`Gemini stopped early (${humanize(finish)}). Try again.`, { code: 'blocked' });
    }
    throw new AIError('Gemini sent back an empty response. Try again.', { code: 'empty' });
  }
  return parseJSONText(text);
}

export function parseJSONText(text) {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new AIError("Gemini's response wasn't valid JSON. Try again.", { code: 'bad_json' });
  }
}

function toAIError(status, data, modelId) {
  const message = errorMessage(data);
  const details = data?.error?.details ?? [];
  const reason = details.find((d) => d?.reason)?.reason ?? '';
  const detail = [`HTTP ${status}`, data?.error?.status, message].filter(Boolean).join(' · ');

  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(message)) {
    return new AIError("That API key isn't valid. Copy it again from Google AI Studio.", {
      code: 'bad_key',
      status,
    });
  }
  if (status === 401 || status === 403) {
    return new AIError("This API key can't use the Gemini API. Create one in Google AI Studio.", {
      code: 'bad_key',
      status,
    });
  }
  if (status === 404) {
    return new AIError(`The model "${modelId}" isn't available. Pick another model in Settings.`, {
      code: 'bad_model',
      status,
    });
  }
  if (status === 429) {
    const retryAfterSec = parseRetryDelay(details);
    const daily = /per ?day/i.test(`${message} ${JSON.stringify(details)}`);
    return new AIError(
      daily
        ? "You've used today's free Gemini quota for this model. Switch models in Settings or try again tomorrow."
        : `You hit Gemini's free-tier rate limit. Try again in ${retryAfterSec ? `${retryAfterSec} seconds` : 'a minute'}.`,
      { code: 'rate_limit', status, retryAfterSec, detail },
    );
  }
  if (status === 504) {
    return new AIError('Gemini took too long to answer. Try again, or quiz a shorter article or selection.', {
      code: 'timeout',
      status,
      detail,
    });
  }
  if (status >= 500) {
    return new AIError('Gemini is overloaded right now. Try again in a moment.', {
      code: 'server',
      status,
      detail,
    });
  }
  return new AIError(`Gemini returned an error (${status})${message ? `: ${message}` : '.'}`, {
    code: 'unknown',
    status,
  });
}

function errorMessage(data) {
  return typeof data?.error?.message === 'string' ? data.error.message : '';
}

function parseRetryDelay(details) {
  const info = details.find((d) => String(d?.['@type'] ?? '').endsWith('RetryInfo'));
  const seconds = parseFloat(info?.retryDelay);
  return Number.isFinite(seconds) ? Math.ceil(seconds) : null;
}

function humanize(enumValue) {
  return String(enumValue).toLowerCase().replace(/_/g, ' ');
}

function networkError() {
  return new AIError("Couldn't reach Gemini. Check your internet connection.", { code: 'network' });
}
