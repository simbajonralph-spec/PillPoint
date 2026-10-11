const { GoogleGenAI } = require('@google/genai');

const DEFAULT_MODEL = 'gemini-3.8-flash';
const REQUEST_TIMEOUT_MS = boundedEnvInt('PAI_GEMINI_TIMEOUT_MS', 20000, 1000, 60000);
const MAX_ATTEMPTS = boundedEnvInt('PAI_GEMINI_MAX_ATTEMPTS', 3, 1, 3);
const RETRY_BASE_DELAY_MS = boundedEnvInt('PAI_GEMINI_RETRY_BASE_MS', 250, 25, 2000);
const RETRY_MAX_DELAY_MS = boundedEnvInt('PAI_GEMINI_RETRY_MAX_MS', 2000, 50, 5000);
const COOLDOWN_MS = boundedEnvInt('PAI_GEMINI_COOLDOWN_MS', 10000, 1000, 60000);
const QUOTA_COOLDOWN_MS = boundedEnvInt('PAI_GEMINI_QUOTA_COOLDOWN_MS', 3600000, 1000, 604800000);
const TRANSIENT_FAILURE_THRESHOLD = boundedEnvInt('PAI_GEMINI_COOLDOWN_FAILURES', 2, 2, 5);
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
let consecutiveTransientFailures = 0;
let cooldownUntil = 0;
let cooldownReason = null;

function boundedEnvInt(name, fallback, min, max) {
  const value = Number.parseInt(process.env[name], 10);
  return Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function sanitizeProviderMessage(message) {
  let sanitized = typeof message === 'string' ? message : '';
  sanitized = sanitized
    .replace(/(x-goog-api-key|authorization|cookie|set-cookie)\s*[:=]\s*[^\s,;]+/ig, '$1=[REDACTED]')
    .replace(/\b(?:AIza[0-9A-Za-z_-]{20,}|Bearer\s+\S+)\b/g, '[REDACTED]')
    .replace(/https?:\/\/[^\s"'<>]+/g, '[URL REDACTED]')
    .replace(/[\r\n\t]+/g, ' ')
    .slice(0, 500);
  return sanitized || 'No provider message supplied.';
}

function extractRetryGuidance(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 6) return null;
  for (const [key, entry] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/[^a-z]/g, '');
    if (['retrydelay', 'retryafter', 'retryafterseconds', 'retryafterms'].includes(normalizedKey)) {
      const parsed = normalizedKey.endsWith('ms')
        ? Math.max(0, Number(entry))
        : parseRetryAfter(String(entry));
      if (Number.isFinite(parsed)) return Math.ceil(parsed);
    }
    const nested = extractRetryGuidance(entry, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

function getSafeProviderError(error) {
  const statusValue = error?.status ?? error?.statusCode;
  const status = Number.isInteger(Number(statusValue)) && Number(statusValue) >= 100 && Number(statusValue) <= 599
    ? Number(statusValue)
    : null;
  let providerCode = typeof error?.code === 'string'
    ? error.code
    : (Number.isInteger(error?.code) && error.code >= 400 && error.code <= 599 ? error.code : null);
  let message = typeof error?.message === 'string' ? error.message : '';
  let retryAfterMs = null;

  // The official SDK puts the Google error object inside ApiError.message and
  // exposes only the HTTP status as ApiError.status. Parse only known fields.
  if (message.startsWith('{')) {
    try {
      const parsed = JSON.parse(message);
      if (parsed?.error && typeof parsed.error === 'object') {
        providerCode = parsed.error.status ?? parsed.error.code ?? providerCode;
        message = parsed.error.message ?? message;
        retryAfterMs = extractRetryGuidance(parsed.error.details)
          ?? extractRetryGuidance(parsed.error.metadata);
      }
    } catch { /* Keep a sanitized version of the SDK message. */ }
  }

  if (typeof providerCode !== 'string' && typeof providerCode !== 'number') providerCode = null;
  if (providerCode !== null) providerCode = String(providerCode).replace(/[^\w.-]/g, '').slice(0, 80) || null;
  return { status, providerCode, message: sanitizeProviderMessage(message), retryAfterMs };
}

function isQuotaExhaustion(providerError) {
  return providerError.status === 429
    && /(?:quota|free.?tier|daily limit).{0,120}(?:exceed|exhaust|limit|reached)|(?:exceed|exhaust|reached).{0,80}(?:quota|free.?tier|daily limit)/i
      .test(providerError.message);
}

function logProviderError(error, logger = console.error) {
  const safe = getSafeProviderError(error);
  logger(`P.A.I. Gemini provider request failed: ${JSON.stringify({
    status: safe.status,
    providerCode: safe.providerCode,
  })}`);
  return safe;
}

function logRequestDiagnostic({
  role,
  operation,
  model,
  durationMs,
  payloadBytes,
  status,
  providerCode,
  attempts,
  outcome,
  responseParsingOutcome,
  retryAfterMs = null,
  failureClass = null,
  fallbackUsed = false,
}, logger = console.info) {
  const safeName = value => String(value || 'unknown').replace(/[^\w.-]/g, '').slice(0, 80) || 'unknown';
  logger(`P.A.I. Gemini request: ${JSON.stringify({
    role: safeName(role),
    operation: safeName(operation),
    model: safeName(model),
    durationMs,
    approximatePayloadBytes: payloadBytes,
    status: Number.isInteger(status) ? status : null,
    providerCode: providerCode == null ? null : String(providerCode).replace(/[^\w.-]/g, '').slice(0, 80) || null,
    attempts,
    outcome,
    responseParsingOutcome,
    retryAfterMs: Number.isFinite(retryAfterMs) ? Math.max(0, Math.ceil(retryAfterMs)) : null,
    failureClass: ['provider_failure', 'quota_exhausted', 'invalid_model_output'].includes(failureClass) ? failureClass : null,
    fallbackUsed,
  })}`);
}

function safeDiagnostic(status, providerCode, message, logger = console.error) {
  const diagnostic = {
    status: Number.isInteger(status) ? status : null,
    providerCode: providerCode == null ? null : String(providerCode).replace(/[^\w.-]/g, '').slice(0, 80) || null,
    message: sanitizeProviderMessage(message),
  };
  logger(`P.A.I. Gemini provider request failed: ${JSON.stringify(diagnostic)}`);
  return diagnostic;
}

function isAbort(error, signal) {
  return !!signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError';
}

function isRetryable(error) {
  const { status } = getSafeProviderError(error);
  if (RETRYABLE_STATUSES.has(status)) return true;
  return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED'].includes(error?.code);
}

function waitForRetry(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error('The Gemini request was aborted.'));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(signal.reason || new Error('The Gemini request was aborted.'));
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const duration = String(value).trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s)$/i);
  if (duration) return Math.ceil(Number(duration[1]) * (duration[2].toLowerCase() === 'ms' ? 1 : 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

function getCooldownState(now = Date.now()) {
  return { active: cooldownUntil > now, retryAfterMs: Math.max(0, cooldownUntil - now), reason: cooldownReason };
}

function resetProviderReliabilityState() {
  consecutiveTransientFailures = 0;
  cooldownUntil = 0;
  cooldownReason = null;
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(signal.reason || new Error('The Gemini request was aborted.'));
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason || new Error('The Gemini request was aborted.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(value => {
      cleanup();
      resolve(value);
    }, error => {
      cleanup();
      reject(error);
    });
  });
}

function parseJsonText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new PaiUnavailableError('The Gemini response did not contain a structured answer.');
  }
  let candidate = text.trim();
  const fenced = candidate.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) candidate = fenced[1].trim();
  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new PaiUnavailableError('The Gemini response did not match the expected JSON format.', { cause: error });
  }
}

function validateAgainstSchema(value, schema, path = '$') {
  if (!schema || typeof schema !== 'object') return;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types[0]) {
    const valid = types.some(type => {
      if (type === 'null') return value === null;
      if (type === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
      if (type === 'array') return Array.isArray(value);
      if (type === 'integer') return Number.isInteger(value);
      if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
      return typeof value === type;
    });
    if (!valid) throw new PaiUnavailableError(`Gemini response failed schema validation at ${path}.`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new PaiUnavailableError(`Gemini response failed schema validation at ${path}.`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        throw new PaiUnavailableError(`Gemini response is missing a required field at ${path}.${required}.`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          throw new PaiUnavailableError(`Gemini response contains an unexpected field at ${path}.${key}.`);
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        validateAgainstSchema(value[key], propertySchema, `${path}.${key}`);
      }
    }
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, index) => validateAgainstSchema(item, schema.items, `${path}[${index}]`));
  }
}

function extractResponseText(response) {
  let sdkText = '';
  try {
    if (typeof response?.text === 'string') sdkText = response.text;
  } catch { /* Fall through to the documented candidate content shape. */ }
  if (sdkText.trim()) return sdkText;
  return response?.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '';
}

function getResponseDiagnostics(response) {
  const candidate = response?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  return {
    candidateCount: Number.isInteger(response?.candidates?.length) ? response.candidates.length : 0,
    finishReason: typeof candidate?.finishReason === 'string' ? candidate.finishReason.slice(0, 80) : null,
    blockReason: typeof response?.promptFeedback?.blockReason === 'string'
      ? response.promptFeedback.blockReason.slice(0, 80)
      : null,
    partCount: parts.length,
    textLength: parts.reduce((length, part) => length + (typeof part.text === 'string' ? part.text.length : 0), 0),
  };
}

function getResponseHttpStatus(response) {
  const status = response?.sdkHttpResponse?.responseInternal?.status
    ?? response?.sdkHttpResponse?.status
    ?? response?.sdkHttpResponse?.statusCode;
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

class PaiUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaiUnavailableError';
  }
}

function toGeminiContents(messages) {
  const contents = [];
  const systemInstructions = [];

  for (const message of messages || []) {
    if (!message || typeof message.content !== 'string') continue;
    if (message.role === 'system' || message.role === 'developer') {
      systemInstructions.push(message.content);
      continue;
    }
    contents.push({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    });
  }

  return {
    contents,
    systemInstruction: systemInstructions.length ? systemInstructions.join('\n\n') : undefined,
  };
}

// Gemini supports a useful subset of JSON Schema. Strip unsupported schema
// keywords while keeping the existing P.A.I. response contracts.
function toGeminiSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;
  return Object.fromEntries(Object.entries(schema)
    .filter(([key]) => key !== 'additionalProperties')
    .map(([key, value]) => [key, toGeminiSchema(value)]));
}

async function requestJsonCompletion({
  messages,
  schemaName,
  schema,
  maxTokens = 500,
  diagnosticRole = 'unknown',
  diagnosticOperation = schemaName || 'completion',
  signal: callerSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
  maxAttempts = MAX_ATTEMPTS,
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  const startedAt = Date.now();
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  if (!apiKey) {
    logRequestDiagnostic({
      role: diagnosticRole,
      operation: diagnosticOperation,
      model,
      durationMs: 0,
      payloadBytes: 0,
      status: null,
      providerCode: 'MISSING_API_KEY',
      attempts: 0,
      outcome: 'not_configured',
      responseParsingOutcome: 'not_attempted',
    });
    throw new PaiUnavailableError('P.A.I. is not configured because GEMINI_API_KEY is missing.');
  }

  const cooldown = getCooldownState();
  if (!cooldown.active && cooldownUntil > 0) {
    consecutiveTransientFailures = 0;
    cooldownUntil = 0;
    cooldownReason = null;
  }
  if (cooldown.active) {
    const diagnostic = {
      role: diagnosticRole,
      operation: diagnosticOperation,
      model,
      durationMs: 0,
      status: null,
      providerCode: 'COOLDOWN',
      attempts: 0,
      failureClass: cooldown.reason,
      retryAfterMs: cooldown.retryAfterMs,
      fallbackUsed: false,
    };
    logRequestDiagnostic({ ...diagnostic, payloadBytes: 0, outcome: 'cooldown', responseParsingOutcome: 'not_attempted' });
    const error = new PaiUnavailableError('P.A.I. is temporarily unavailable.');
    error.diagnostic = diagnostic;
    throw error;
  }

  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    const timeoutError = new Error('The Gemini request timed out.');
    timeoutError.name = 'TimeoutError';
    timeoutController.abort(timeoutError);
  }, timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutController.signal])
    : timeoutController.signal;
  const attempts = Math.max(1, Math.min(MAX_ATTEMPTS, Number.isInteger(maxAttempts) ? maxAttempts : MAX_ATTEMPTS));
  const prompt = toGeminiContents(messages);
  const payloadBytes = Buffer.byteLength(JSON.stringify({
    contents: prompt.contents,
    systemInstruction: prompt.systemInstruction,
    generationConfig: {
      maxOutputTokens: maxTokens,
      responseMimeType: 'application/json',
      responseJsonSchema: toGeminiSchema(schema),
    },
  }));
  let attemptCount = 0;
  let httpStatus = null;
  let retryAfterMs = null;
  let response;
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: {
        // The adapter owns the retry loop so backoff, Retry-After, cooldown,
        // cancellation, and the total timeout apply to the whole operation.
        retryOptions: { attempts: 1 },
        fetch: async (url, init) => {
          const providerResponse = await fetch(url, init);
          httpStatus = providerResponse.status;
          retryAfterMs = parseRetryAfter(providerResponse.headers.get('retry-after'));
          return providerResponse;
        },
      },
    });
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        attemptCount = attempt;
        if (signal.aborted) throw signal.reason || new Error('The Gemini request was aborted.');
        response = await abortable(ai.models.generateContent({
          model,
          contents: prompt.contents,
          config: {
            systemInstruction: prompt.systemInstruction,
            maxOutputTokens: maxTokens,
            responseMimeType: 'application/json',
            responseJsonSchema: toGeminiSchema(schema),
            abortSignal: signal,
          },
        }), signal);
        consecutiveTransientFailures = 0;
        cooldownUntil = 0;
        cooldownReason = null;
        break;
      } catch (error) {
        const providerError = getSafeProviderError(error);
        if (attempt >= attempts || isAbort(error, signal)
          || isQuotaExhaustion(providerError) || !isRetryable(error)) throw error;
        const exponentialDelay = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)));
        const jitteredDelay = Math.max(1, Math.floor(exponentialDelay * (0.75 + Math.random() * 0.5)));
        const providerRetryAfterMs = retryAfterMs ?? providerError.retryAfterMs;
        const delay = providerRetryAfterMs === null ? jitteredDelay : Math.max(providerRetryAfterMs, jitteredDelay);
        if (Date.now() - startedAt + delay >= timeoutMs) throw error;
        await waitForRetry(delay, signal);
      }
    }
  } catch (error) {
    const safeError = getSafeProviderError(error);
    if (!safeError.status && isAbort(error, signal)) {
      safeError.providerCode = timeoutController.signal.aborted ? 'TIMEOUT' : 'ABORTED';
    }
    const finalStatus = safeError.status ?? httpStatus;
    const providerRetryAfterMs = retryAfterMs ?? safeError.retryAfterMs;
    const quotaExhausted = isQuotaExhaustion({ ...safeError, status: finalStatus });
    const transientFailure = RETRYABLE_STATUSES.has(finalStatus) && !quotaExhausted;
    if (quotaExhausted) {
      cooldownUntil = Date.now() + Math.max(QUOTA_COOLDOWN_MS, providerRetryAfterMs || 0);
      consecutiveTransientFailures = 0;
      cooldownReason = 'quota_exhausted';
    } else if (transientFailure) {
      consecutiveTransientFailures += 1;
      if (consecutiveTransientFailures >= TRANSIENT_FAILURE_THRESHOLD || (providerRetryAfterMs || 0) > 0) {
        cooldownUntil = Date.now() + Math.max(COOLDOWN_MS, providerRetryAfterMs || 0);
        cooldownReason = 'provider_failure';
      }
    } else {
      consecutiveTransientFailures = 0;
      cooldownReason = null;
    }
    const diagnostic = {
      role: diagnosticRole,
      operation: diagnosticOperation,
      model,
      durationMs: Date.now() - startedAt,
      status: finalStatus,
      providerCode: safeError.providerCode,
      attempts: attemptCount,
      retryAfterMs: providerRetryAfterMs,
      failureClass: quotaExhausted ? 'quota_exhausted' : 'provider_failure',
      fallbackUsed: false,
    };
    logRequestDiagnostic({
      ...diagnostic,
      payloadBytes,
      outcome: quotaExhausted ? 'quota_exhausted' : 'provider_failure',
      retryAfterMs: providerRetryAfterMs,
      failureClass: quotaExhausted ? 'quota_exhausted' : 'provider_failure',
      responseParsingOutcome: 'not_attempted',
    });
    const unavailableError = new PaiUnavailableError('The Gemini request failed.', { cause: error });
    unavailableError.diagnostic = diagnostic;
    throw unavailableError;
  } finally {
    clearTimeout(timeoutTimer);
  }

  let parsed;
  let responseParsingOutcome = 'malformed_json';
  try {
    if (getResponseDiagnostics(response).finishReason === 'MAX_TOKENS') {
      responseParsingOutcome = 'truncated_output';
      throw new PaiUnavailableError('The Gemini response was truncated at its output token limit.');
    }
    const content = extractResponseText(response);
    if (!content.trim()) responseParsingOutcome = 'empty_response';
    parsed = parseJsonText(content);
    responseParsingOutcome = 'schema_validation_failed';
    validateAgainstSchema(parsed, schema);
    responseParsingOutcome = 'valid';
  } catch (error) {
    const responseInfo = getResponseDiagnostics(response);
    logRequestDiagnostic({
      role: diagnosticRole,
      operation: diagnosticOperation,
      model,
      durationMs: Date.now() - startedAt,
      payloadBytes,
      status: httpStatus ?? getResponseHttpStatus(response),
      providerCode: `INVALID_RESPONSE_${responseInfo.finishReason || responseInfo.blockReason || responseParsingOutcome}`,
      attempts: attemptCount,
      outcome: 'invalid_model_output',
      responseParsingOutcome,
      failureClass: 'invalid_model_output',
      fallbackUsed: true,
    });
    const unavailableError = error instanceof PaiUnavailableError
      ? error
      : new PaiUnavailableError('The Gemini response could not be safely parsed.', { cause: error });
    unavailableError.diagnostic = {
      role: diagnosticRole,
      operation: diagnosticOperation,
      model,
      durationMs: Date.now() - startedAt,
      status: httpStatus ?? getResponseHttpStatus(response),
      providerCode: `INVALID_RESPONSE_${responseInfo.finishReason || responseInfo.blockReason || responseParsingOutcome}`,
      attempts: attemptCount,
      failureClass: 'invalid_model_output',
      fallbackUsed: true,
    };
    throw unavailableError;
  }
  logRequestDiagnostic({
    role: diagnosticRole,
    operation: diagnosticOperation,
    model,
    durationMs: Date.now() - startedAt,
    payloadBytes,
    status: httpStatus ?? getResponseHttpStatus(response),
    providerCode: null,
    attempts: attemptCount,
    outcome: 'success',
    responseParsingOutcome,
    failureClass: null,
  });
  return parsed;
}

module.exports = {
  DEFAULT_MODEL,
  MAX_ATTEMPTS,
  QUOTA_COOLDOWN_MS,
  getSafeProviderError,
  logProviderError,
  parseJsonText,
  validateAgainstSchema,
  PaiUnavailableError,
  requestJsonCompletion,
  toGeminiContents,
  toGeminiSchema,
  parseRetryAfter,
  getCooldownState,
  resetProviderReliabilityState,
};
