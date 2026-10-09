const DEFAULT_MODEL = 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const DEFAULT_RETRY_DELAYS_MS = [500, 1500];
const MAX_RETRY_DELAY_MS = 5000;

class PaiUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaiUnavailableError';
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function retryDelayMs(response, attempt) {
  const retryAfterSeconds = Number(response.headers.get('retry-after'));
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0) {
    return Math.min(retryAfterSeconds * 1000, MAX_RETRY_DELAY_MS);
  }
  return DEFAULT_RETRY_DELAYS_MS[attempt] ?? MAX_RETRY_DELAY_MS;
}

async function providerDetail(response) {
  try {
    const payload = await response.json();
    const error = payload?.error;
    const message = typeof error?.message === 'string' && error.message ? `: ${error.message}` : '';
    const permanent = error?.type === 'insufficient_quota' || error?.code === 'credit_balance_exhausted';
    return { message, permanent };
  } catch {
    return { message: '', permanent: false };
  }
}

async function requestJsonCompletion({ messages, schemaName, schema, maxTokens = 500 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new PaiUnavailableError('P.A.I. is not configured because OPENAI_API_KEY is missing.');
  }

  const body = JSON.stringify({
    model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
    messages,
    max_tokens: maxTokens,
    response_format: {
      type: 'json_schema',
      json_schema: { name: schemaName, strict: true, schema },
    },
  });

  let response;
  for (let attempt = 0; ; attempt += 1) {
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body,
        signal: AbortSignal.timeout(20000),
      });
    } catch (error) {
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(DEFAULT_RETRY_DELAYS_MS[attempt] ?? MAX_RETRY_DELAY_MS);
        continue;
      }
      throw new PaiUnavailableError('The OpenAI request failed.', { cause: error });
    }

    if (response.ok) break;
    const detail = await providerDetail(response);
    if (RETRYABLE_STATUS.has(response.status) && !detail.permanent && attempt < MAX_ATTEMPTS - 1) {
      await sleep(retryDelayMs(response, attempt));
      continue;
    }
    throw new PaiUnavailableError(`The OpenAI request returned HTTP ${response.status}${detail.message}.`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    throw new PaiUnavailableError('The OpenAI response was not valid JSON.', { cause: error });
  }

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new PaiUnavailableError('The OpenAI response did not contain a structured answer.');
  }

  try {
    return JSON.parse(content);
  } catch (error) {
    throw new PaiUnavailableError('The OpenAI response did not match the expected JSON format.', { cause: error });
  }
}

module.exports = {
  PaiUnavailableError,
  requestJsonCompletion,
};
