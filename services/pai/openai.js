const DEFAULT_MODEL = 'gpt-4o-mini';
const API_URL = 'https://api.openai.com/v1/chat/completions';

class PaiUnavailableError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'PaiUnavailableError';
  }
}

async function requestJsonCompletion({ messages, schemaName, schema, maxTokens = 500 }) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new PaiUnavailableError('P.A.I. is not configured because OPENAI_API_KEY is missing.');
  }

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
        messages,
        max_tokens: maxTokens,
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, strict: true, schema },
        },
      }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new PaiUnavailableError('The OpenAI request failed.', { cause: error });
  }

  if (!response.ok) {
    throw new PaiUnavailableError(`The OpenAI request returned HTTP ${response.status}.`);
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
