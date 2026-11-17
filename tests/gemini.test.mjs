import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateJSON,
  testConnection,
  checkKey,
  parseGenerateResponse,
  parseJSONText,
  buildRequestBody,
} from '../extension/lib/gemini.js';

const schema = { type: 'object', properties: { ok: { type: 'boolean' } } };

function reply(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function textReply(text, extra = {}) {
  return reply(200, { candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] }, ...extra }] });
}

function recorder(...responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl };
}

const base = { apiKey: 'test-key', system: 'sys', prompt: 'hello', schema };

const overloaded = () =>
  reply(503, { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded.' } });

test('buildRequestBody asks for JSON that matches the schema', () => {
  const body = buildRequestBody({ system: 'sys', prompt: 'p', schema, thinkingLevel: 'low' });
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: 'p' }] }]);
  assert.equal(body.generationConfig.responseMimeType, 'application/json');
  assert.equal(body.generationConfig.responseJsonSchema, schema);
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
  assert.equal(
    buildRequestBody({ system: 's', prompt: 'p', schema }).generationConfig.thinkingConfig,
    undefined,
  );
});

test('buildRequestBody puts attachments before the prompt', () => {
  const body = buildRequestBody({
    system: 's',
    prompt: 'p',
    schema,
    attachments: [{ mimeType: 'application/pdf', data: 'QUJD' }],
  });
  assert.deepEqual(body.contents[0].parts, [
    { inlineData: { mimeType: 'application/pdf', data: 'QUJD' } },
    { text: 'p' },
  ]);
});

test('generateJSON sends the key in a header and parses the reply', async () => {
  const { calls, fetchImpl } = recorder(textReply('{"ok":true}'));
  const result = await generateJSON({ ...base, model: 'models/gemini-3.8-flash', fetchImpl });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(
    calls[0].url,
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
  );
  assert.equal(calls[0].init.headers['x-goog-api-key'], 'test-key');
  assert.ok(!calls[0].url.includes('test-key'), 'key must not be in the URL');
  assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

test('generateJSON skips thinkingLevel for Gemini 2.x models', async () => {
  const { calls, fetchImpl } = recorder(textReply('{"ok":true}'));
  await generateJSON({ ...base, model: 'gemini-2.5-flash', fetchImpl });
  assert.equal(calls[0].body.generationConfig.thinkingConfig, undefined);
});

test('generateJSON retries without thinkingLevel when a model rejects it', async () => {
  const { calls, fetchImpl } = recorder(
    reply(400, {
      error: {
        code: 400,
        message: 'Thinking level is not supported for this model.',
        status: 'INVALID_ARGUMENT',
      },
    }),
    textReply('{"ok":true}'),
  );
  assert.deepEqual(await generateJSON({ ...base, model: 'gemini-flash-latest', fetchImpl }), { ok: true });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig);
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined);
});

test('generateJSON explains common API errors', async () => {
  const cases = [
    [
      reply(400, {
        error: {
          message: 'API key not valid. Please pass a valid API key.',
          details: [{ reason: 'API_KEY_INVALID' }],
        },
      }),
      'bad_key',
      /isn't valid/,
    ],
    [reply(403, { error: { message: 'Permission denied' } }), 'bad_key', /can't use the Gemini API/],
    [reply(404, { error: { message: 'models/nope is not found' } }), 'bad_model', /"nope" isn't available/],
    [
      reply(429, {
        error: {
          message: 'Resource has been exhausted',
          details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '17.2s' }],
        },
      }),
      'rate_limit',
      /Try again in 18 seconds/,
    ],
    [
      reply(429, {
        error: {
          message: 'Quota exceeded',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
              violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }],
            },
          ],
        },
      }),
      'rate_limit',
      /today's free Gemini quota/,
    ],
    [reply(418, { error: { message: 'Teapot' } }), 'unknown', /\(418\): Teapot/],
  ];
  for (const [response, code, message] of cases) {
    const { fetchImpl } = recorder(response);
    await assert.rejects(generateJSON({ ...base, model: 'nope', fetchImpl }), (err) => {
      assert.equal(err.code, code);
      assert.match(err.message, message);
      return true;
    });
  }
});

test('generateJSON reports network failures and passes aborts through', async () => {
  const { fetchImpl } = recorder(new TypeError('Failed to fetch'));
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl }), { code: 'network' });

  const abort = new DOMException('The user aborted a request.', 'AbortError');
  const aborted = recorder(abort);
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl: aborted.fetchImpl }), {
    name: 'AbortError',
  });

  // Cancelled while the reply was still arriving.
  const midBody = recorder({
    ok: true,
    status: 200,
    json: async () => {
      throw abort;
    },
  });
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl: midBody.fetchImpl }), {
    name: 'AbortError',
  });
});

test('generateJSON requires a key before calling the API', async () => {
  const { calls, fetchImpl } = recorder();
  await assert.rejects(generateJSON({ ...base, apiKey: '', model: 'gemini-3.8-flash', fetchImpl }), {
    code: 'no_key',
  });
  assert.equal(calls.length, 0);
});

test('the key is sent without invisible characters, and other stray characters are rejected', async () => {
  const { calls, fetchImpl } = recorder(textReply('{"ok":true}'), reply(200, {}));
  await generateJSON({ ...base, apiKey: ' test\u200b-key\n', model: 'gemini-3.8-flash', fetchImpl });
  await testConnection({ apiKey: '\ufefftest-key ', model: 'gemini-3.8-flash', fetchImpl });
  assert.deepEqual(
    calls.map((c) => c.init.headers['x-goog-api-key']),
    ['test-key', 'test-key'],
  );

  const bad = { apiKey: 'tést-key', model: 'gemini-3.8-flash', fetchImpl };
  await assert.rejects(generateJSON({ ...base, ...bad }), { code: 'bad_key', message: /cannot appear/ });
  await assert.rejects(testConnection(bad), { code: 'bad_key' });
  assert.equal(calls.length, 2, 'neither reaches the API');
});

test('parseGenerateResponse ignores thought parts', () => {
  const data = {
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: 'thinking...', thought: true }, { text: '{"a":' }, { text: '1}' }] },
      },
    ],
  };
  assert.deepEqual(parseGenerateResponse(data), { a: 1 });
});

test('parseGenerateResponse surfaces blocks and cut-off output', () => {
  assert.throws(() => parseGenerateResponse({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }), {
    code: 'blocked',
    message: /prohibited content/,
  });
  assert.throws(
    () =>
      parseGenerateResponse({
        candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"a":' }] } }],
      }),
    { code: 'truncated' },
  );
  assert.throws(() => parseGenerateResponse({ candidates: [{ finishReason: 'SAFETY' }] }), {
    code: 'blocked',
  });
  assert.throws(() => parseGenerateResponse({ candidates: [] }), { code: 'empty' });
});

test('parseJSONText tolerates code fences', () => {
  assert.deepEqual(parseJSONText('```json\n{"a": 1}\n```'), { a: 1 });
  assert.throws(() => parseJSONText('not json'), { code: 'bad_json' });
});

test('testConnection checks the model endpoint with the key header', async () => {
  const ok = recorder(reply(200, { name: 'models/gemini-3.8-flash' }));
  assert.equal(
    await testConnection({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl: ok.fetchImpl }),
    true,
  );
  assert.equal(ok.calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash');
  assert.equal(ok.calls[0].init.headers['x-goog-api-key'], 'k');

  const bad = recorder(
    reply(400, { error: { message: 'API key not valid.', details: [{ reason: 'API_KEY_INVALID' }] } }),
  );
  await assert.rejects(testConnection({ apiKey: 'k', model: 'gemini-3.8-flash', fetchImpl: bad.fetchImpl }), {
    code: 'bad_key',
  });
});

test('checkKey rejects only keys Gemini turns down', async () => {
  const model = 'gemini-3.8-flash';
  const ok = recorder(reply(200, { name: `models/${model}` }));
  assert.equal(await checkKey({ apiKey: 'k', model, fetchImpl: ok.fetchImpl }), null);

  const limited = recorder(reply(429, { error: { code: 429, message: 'Resource exhausted' } }));
  assert.equal((await checkKey({ apiKey: 'k', model, fetchImpl: limited.fetchImpl })).code, 'rate_limit');
  const offline = recorder(new TypeError('Failed to fetch'));
  assert.equal((await checkKey({ apiKey: 'k', model, fetchImpl: offline.fetchImpl })).code, 'network');

  const bad = recorder(reply(403, { error: { message: 'Permission denied.' } }));
  await assert.rejects(checkKey({ apiKey: 'k', model, fetchImpl: bad.fetchImpl }), { code: 'bad_key' });
});

test('generateJSON reports an overload at once and keeps what Gemini said', async () => {
  const { calls, fetchImpl } = recorder(overloaded(), textReply('{"ok":true}'));
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl }), (err) => {
    assert.equal(err.code, 'server');
    assert.match(err.message, /overloaded/);
    assert.equal(err.detail, 'HTTP 503 · UNAVAILABLE · The model is overloaded.');
    return true;
  });
  assert.equal(calls.length, 1, 'retrying is up to the caller');
});

test('generateJSON explains timeouts separately and does not resend them', async () => {
  const { calls, fetchImpl } = recorder(
    reply(504, { error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'Deadline expired.' } }),
  );
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl }), {
    code: 'timeout',
    message: /took too long/,
  });
  assert.equal(calls.length, 1);
});

// Settles after `ms`, unless the request is cancelled or runs out of time first.
function slowly(init, ms, value) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms, value);
    init.signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(init.signal.reason);
      },
      { once: true },
    );
  });
}

test('generateJSON gives up on a model that does not answer in time, without trying it again', async () => {
  const calls = [];
  const fetchImpl = (url, init) => {
    calls.push(url);
    return slowly(init, 5000, textReply('{"ok":true}'));
  };
  await assert.rejects(
    generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl, timeoutMs: 50 }),
    (err) => {
      assert.equal(err.code, 'server', 'so another model gets a chance');
      assert.equal(err.timedOut, true);
      assert.match(err.detail, /^No response from gemini-3\.8-flash within \d+ seconds$/);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('generateJSON also stops waiting for a reply that stalls partway through', async () => {
  const fetchImpl = async (url, init) => ({ ok: true, status: 200, json: () => slowly(init, 5000, {}) });
  await assert.rejects(generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl, timeoutMs: 50 }), {
    code: 'server',
    timedOut: true,
  });
});

test('generateJSON gives each attempt 45 seconds, or two minutes with a file attached', async (t) => {
  const timeout = t.mock.method(AbortSignal, 'timeout');
  const { fetchImpl } = recorder(textReply('{"ok":true}'), textReply('{"ok":true}'));
  await generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl });
  const attachments = [{ mimeType: 'application/pdf', data: 'QUJD' }];
  await generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl, attachments });
  assert.deepEqual(
    timeout.mock.calls.map((call) => call.arguments[0]),
    [45_000, 120_000],
  );
});

test('a cancel passes through unchanged while the time limit runs', async () => {
  const controller = new AbortController();
  const fetchImpl = (url, init) => slowly(init, 5000, textReply('{"ok":true}'));
  const request = generateJSON({ ...base, model: 'gemini-3.8-flash', fetchImpl, signal: controller.signal });
  controller.abort();
  await assert.rejects(request, (err) => {
    assert.equal(err, controller.signal.reason);
    return true;
  });
});

test('the time limit and cancelling still work without AbortSignal.any', async (t) => {
  const { any } = AbortSignal;
  AbortSignal.any = undefined;
  t.after(() => {
    AbortSignal.any = any;
  });
  const fetchImpl = (url, init) => slowly(init, 5000, textReply('{"ok":true}'));
  const controller = new AbortController();
  const request = { ...base, model: 'gemini-3.8-flash', fetchImpl, signal: controller.signal };
  await assert.rejects(generateJSON({ ...request, timeoutMs: 50 }), { code: 'server', timedOut: true });
  const cancelled = generateJSON(request);
  controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' });
});
