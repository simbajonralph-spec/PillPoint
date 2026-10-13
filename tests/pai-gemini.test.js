const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getCooldownState,
  MAX_ATTEMPTS,
  QUOTA_COOLDOWN_MS,
  PaiUnavailableError,
  parseRetryAfter,
  requestJsonCompletion,
  resetProviderReliabilityState,
} = require('../services/pai/gemini');

const schema = {
  type: 'object',
  properties: { message: { type: 'string' } },
  required: ['message'],
  additionalProperties: false,
};

function mockProvider(t, replies) {
  resetProviderReliabilityState();
  const previousFetch = global.fetch;
  const previousKey = process.env.GEMINI_API_KEY;
  const previousModel = process.env.GEMINI_MODEL;
  let requests = 0;
  process.env.GEMINI_API_KEY = 'test-key';
  global.fetch = async (url, init) => {
    requests += 1;
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    assert.equal(init.headers.get('x-goog-api-key'), 'test-key');
    const reply = replies[Math.min(requests - 1, replies.length - 1)];
    if (reply.waitForAbort) {
      return new Promise((resolve, reject) => {
        const abort = () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init.signal?.aborted) return abort();
        init.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status || 200,
      headers: { 'Content-Type': 'application/json', ...(reply.headers || {}) },
    });
  };
  t.after(() => {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
    if (previousModel === undefined) delete process.env.GEMINI_MODEL;
    else process.env.GEMINI_MODEL = previousModel;
  });
  return () => requests;
}

function success(text, finishReason = 'STOP') {
  return { body: { candidates: [{ finishReason, content: { role: 'model', parts: [{ text }] } }] } };
}

function unavailable() {
  return { status: 503, body: { error: { code: 503, status: 'UNAVAILABLE', message: 'This model is currently experiencing high demand.' } } };
}

function rateLimited(headers = {}) {
  return { status: 429, headers, body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Rate limited.' } } };
}

const request = options => requestJsonCompletion({
  messages: [{ role: 'user', content: 'test prompt' }],
  schema,
  ...options,
});

test('Gemini retries a transient 503 and returns a successful structured response', async t => {
  const requests = mockProvider(t, [unavailable(), success('{"message":"Recovered."}')]);
  const result = await request();
  assert.deepEqual(result, { message: 'Recovered.' });
  assert.equal(requests(), 2);
});

test('Gemini stops after its bounded attempts when 503 persists', async t => {
  const requests = mockProvider(t, [unavailable()]);
  const previousInfo = console.info;
  const diagnostics = [];
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });
  await assert.rejects(request(), error => error instanceof PaiUnavailableError && /request failed/i.test(error.message));
  assert.equal(requests(), MAX_ATTEMPTS);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /503/);
  assert.match(diagnostics[0], /UNAVAILABLE/);
});

test('Gemini stops after its bounded attempts when 429 persists', async t => {
  const requests = mockProvider(t, [rateLimited()]);
  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  assert.equal(requests(), MAX_ATTEMPTS);
});

test('Gemini quota exhaustion skips retries and opens the quota cooldown', async t => {
  const requests = mockProvider(t, [{
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Free-tier request quota exceeded.' } },
  }]);
  const diagnostics = [];
  const previousInfo = console.info;
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });

  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  assert.equal(requests(), 1, 'an exhausted quota is not retried in the same operation');
  assert.equal(getCooldownState().active, true);
  assert.equal(getCooldownState().reason, 'quota_exhausted');
  assert.ok(getCooldownState().retryAfterMs >= QUOTA_COOLDOWN_MS - 100);
  assert.match(diagnostics[0], /"outcome":"quota_exhausted"/);
  assert.match(diagnostics[0], /"failureClass":"quota_exhausted"/);

  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  assert.equal(requests(), 1, 'requests during cooldown do not reach Gemini');
  resetProviderReliabilityState();
});

test('Gemini quota cooldown honors provider retry guidance', async t => {
  const requests = mockProvider(t, [{
    status: 429,
    headers: { 'Retry-After': '7200' },
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Free-tier quota exceeded.' } },
  }]);
  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  assert.equal(requests(), 1);
  assert.equal(getCooldownState().reason, 'quota_exhausted');
  assert.ok(getCooldownState().retryAfterMs >= 7200000 - 100);

  const providerError = {
    status: 429,
    message: JSON.stringify({ error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: 'Free-tier quota exceeded.',
      details: [{ '@type': 'google.rpc.RetryInfo', retryDelay: '7200s' }],
    } }),
  };
  assert.equal(require('../services/pai/gemini').getSafeProviderError(providerError).retryAfterMs, 7200000);
  resetProviderReliabilityState();
});

test('Gemini respects Retry-After before retrying', async t => {
  const requests = mockProvider(t, [rateLimited({ 'Retry-After': '1' }), success('{"message":"After wait."}')]);
  const startedAt = Date.now();
  assert.deepEqual(await request(), { message: 'After wait.' });
  assert.equal(requests(), 2);
  assert.ok(Date.now() - startedAt >= 900);
  assert.equal(parseRetryAfter('2'), 2000);
  assert.equal(parseRetryAfter('invalid'), null);
});

test('Gemini opens a short cooldown after repeated transient operation failures', async t => {
  const requests = mockProvider(t, [unavailable()]);
  resetProviderReliabilityState();
  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  const duringCooldown = getCooldownState();
  assert.equal(duringCooldown.active, true);
  const countBeforeCooldownCall = requests();
  await assert.rejects(request(), error => error instanceof PaiUnavailableError && /temporarily unavailable/i.test(error.message));
  assert.equal(requests(), countBeforeCooldownCall);
  resetProviderReliabilityState();
});

test('a transient provider cooldown for one role does not block another role', async t => {
  const requests = mockProvider(t, [unavailable()]);
  const originalInfo = console.info;
  console.info = () => {};
  t.after(() => { console.info = originalInfo; });
  const pharmacyRequest = options => request({ ...options, diagnosticRole: 'pharmacy_staff' });
  await assert.rejects(pharmacyRequest(), error => error instanceof PaiUnavailableError);
  await assert.rejects(pharmacyRequest(), error => error instanceof PaiUnavailableError);
  assert.equal(getCooldownState('pharmacy_staff').active, true);
  assert.equal(getCooldownState('admin').active, false);
  await assert.rejects(request({ diagnosticRole: 'admin' }), error => error instanceof PaiUnavailableError);
  assert.equal(getCooldownState('admin').active, false);
  assert.equal(requests(), MAX_ATTEMPTS * 3);
  resetProviderReliabilityState();
});

test('a quota cooldown blocks requests across all roles', async t => {
  const requests = mockProvider(t, [{
    status: 429,
    body: { error: { code: 429, status: 'RESOURCE_EXHAUSTED', message: 'Free-tier request quota exceeded.' } },
  }]);
  await assert.rejects(request({ diagnosticRole: 'customer' }), error => error instanceof PaiUnavailableError);
  assert.equal(getCooldownState('customer').reason, 'quota_exhausted');
  assert.equal(getCooldownState('pharmacy_staff').reason, 'quota_exhausted');
  assert.equal(getCooldownState('admin').active, true);
  await assert.rejects(request({ diagnosticRole: 'admin' }), error => error instanceof PaiUnavailableError
    && error.diagnostic.providerCode === 'COOLDOWN');
  assert.equal(requests(), 1);
  resetProviderReliabilityState();
});

test('Gemini does not retry caller-cancelled or timed out requests', async t => {
  const requests = mockProvider(t, [{ waitForAbort: true }]);
  const controller = new AbortController();
  const pending = request({ signal: controller.signal, timeoutMs: 1000 });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(pending, error => error instanceof PaiUnavailableError && /request failed/i.test(error.message));
  assert.equal(requests(), 1);

  const timeoutRequests = mockProvider(t, [{ waitForAbort: true }]);
  const diagnostics = [];
  const previousInfo = console.info;
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });
  await assert.rejects(request({ timeoutMs: 10 }), error => error instanceof PaiUnavailableError);
  assert.equal(timeoutRequests(), 1);
  assert.match(diagnostics[0], /"providerCode":"TIMEOUT"/);
  assert.match(diagnostics[0], /"status":null/);
});

test('Gemini parses plain JSON and fenced JSON and safely rejects empty or malformed output', async t => {
  mockProvider(t, [success('{"message":"Plain."}')]);
  assert.deepEqual(await request(), { message: 'Plain.' });

  mockProvider(t, [success('```json\n{"message":"Fenced."}\n```')]);
  assert.deepEqual(await request(), { message: 'Fenced.' });

  for (const content of ['', 'not JSON']) {
    const logs = [];
    const previousInfo = console.info;
    console.info = message => logs.push(String(message));
    const local = mockProvider(t, [success(content)]);
    await assert.rejects(request(), error => error instanceof PaiUnavailableError);
    assert.equal(local(), 1);
    assert.equal(logs.length, 1);
    assert.match(logs[0], /INVALID_RESPONSE/);
    console.info = previousInfo;
  }
});

test('Gemini rejects missing required fields and unexpected response shapes', async t => {
  for (const content of ['{}', '[]', '{"message":"ok","extra":"unexpected"}']) {
    mockProvider(t, [success(content)]);
    const previousError = console.error;
    console.error = () => {};
    await assert.rejects(request(), error => error instanceof PaiUnavailableError);
    console.error = previousError;
  }
});

test('Gemini rejects MAX_TOKENS output even when it contains parseable JSON', async t => {
  const requests = mockProvider(t, [success('{"message":"Possibly truncated but parseable."}', 'MAX_TOKENS')]);
  const diagnostics = [];
  const previousInfo = console.info;
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });

  await assert.rejects(request(), error => error instanceof PaiUnavailableError);
  assert.equal(requests(), 1);
  assert.match(diagnostics[0], /"outcome":"invalid_model_output"/);
  assert.match(diagnostics[0], /"responseParsingOutcome":"truncated_output"/);
  assert.match(diagnostics[0], /"providerCode":"INVALID_RESPONSE_MAX_TOKENS"/);
  assert.match(diagnostics[0], /"failureClass":"invalid_model_output"/);
});

test('Gemini diagnostics include request metadata without logging prompt text', async t => {
  mockProvider(t, [success('{"message":"Safe answer."}')]);
  const diagnostics = [];
  const previousInfo = console.info;
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });

  const privatePrompt = 'Synthetic customer detail 555-010-2020';
  const result = await requestJsonCompletion({
    messages: [{ role: 'user', content: privatePrompt }],
    schema,
    diagnosticRole: 'pharmacy_staff',
    diagnosticOperation: 'analytics_explanation',
  });
  assert.deepEqual(result, { message: 'Safe answer.' });
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0], /"role":"pharmacy_staff"/);
  assert.match(diagnostics[0], /"model":/);
  assert.match(diagnostics[0], /"approximatePayloadBytes":\d+/);
  assert.match(diagnostics[0], /"durationMs":\d+/);
  assert.match(diagnostics[0], /"status":200/);
  assert.match(diagnostics[0], /"responseParsingOutcome":"valid"/);
  assert.doesNotMatch(diagnostics[0], /Synthetic customer detail|555-010-2020|test-key/);
});
