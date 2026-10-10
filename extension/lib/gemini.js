// https://ai.google.dev/api/generate-content

import { cleanModelId } from './storage.js';

const API_ROOT = 'https://generativelanguage.googleapis.com/v1beta';
// Overloads usually clear within seconds. A timeout (504) mostly comes from a
// long input, so resending the same request wouldn't help.
const TRANSIENT_STATUSES = new Set([500, 502, 503]);
const RETRY_DELAYS = [1500, 4000];

// detail holds what Gemini itself said, for showing in small print.
export class AIError extends Error {
  constructor(message, { code = 'unknown', status = 0, retryAfterSec = null, detail = '' } = {}) {
    super(message);
    this.name = 'AIError';
    this.code = code;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
    this.detail = detail;
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

export async function generateJSON({
  apiKey,
  model,
  system,
  prompt,
  schema,
  attachments,
  signal,
  fetchImpl = fetch,
}) {
  const key = cleanKey(apiKey);
  if (!key) throw new AIError('Add your Gemini API key first.', { code: 'no_key' });
  const modelId = cleanModelId(model);
  if (!modelId) throw new AIError('Choose a Gemini model in Settings.', { code: 'bad_model' });

  const url = `${API_ROOT}/models/${encodeURIComponent(modelId)}:generateContent`;
  // Low thinking keeps quizzes fast; the questions come straight from the text.
  let body = buildRequestBody({
    system,
    prompt,
    schema,
    attachments,
    thinkingLevel: acceptsThinkingLevel(modelId) ? 'low' : null,
  });
  let retries = 0;
  let res;
  while (true) {
    res = await send(fetchImpl, url, key, body, signal);
    if (
      res.status === 400 &&
      body.generationConfig.thinkingConfig &&
      /thinking/i.test(errorMessage(res.data))
    ) {
      body = buildRequestBody({ system, prompt, schema, attachments, thinkingLevel: null });
    } else if (TRANSIENT_STATUSES.has(res.status) && retries < RETRY_DELAYS.length) {
      await delay(RETRY_DELAYS[retries++], signal);
    } else {
      break;
    }
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
    if (err?.name === 'AbortError') throw err;
    throw networkError();
  }
  // A cancel can also land while the body is still arriving.
  const data = await res.json().catch((err) => {
    if (err?.name === 'AbortError') throw err;
    return null;
  });
  return { ok: res.ok, status: res.status, data };
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

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
