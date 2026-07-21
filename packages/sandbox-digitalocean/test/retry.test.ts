import { describe, expect, it } from 'vitest';
import { DigitalOceanApiError } from '../src/client.js';
import { isRetriable, withDigitalOceanRetry } from '../src/retry.js';

describe('isRetriable', () => {
  it('retries 429 + rate_limit_exceeded code regardless of idempotency', () => {
    const err = new DigitalOceanApiError(429, 'rate_limit_exceeded', 'Slow down');
    expect(isRetriable(err, false)).toBe(true);
    expect(isRetriable(err, true)).toBe(true);
  });

  it('retries `locked` and `conflict` codes (server tells us to wait)', () => {
    expect(isRetriable(new DigitalOceanApiError(409, 'locked', 'busy'), false)).toBe(true);
    expect(isRetriable(new DigitalOceanApiError(409, 'conflict', 'busy'), false)).toBe(true);
  });

  it('classifies 5xx as ambiguous (retried only when caller opts in)', () => {
    const err = new DigitalOceanApiError(502, 'http_502', 'bad gateway');
    expect(isRetriable(err, false)).toBe(false);
    expect(isRetriable(err, true)).toBe(true);
  });

  it('never retries permanent 4xx (auth, validation, not_found)', () => {
    expect(isRetriable(new DigitalOceanApiError(401, 'unauthorized', 'token bad'), true)).toBe(false);
    expect(isRetriable(new DigitalOceanApiError(404, 'not_found', 'no such'), true)).toBe(false);
    expect(isRetriable(new DigitalOceanApiError(422, 'invalid_input', 'bad cidr'), true)).toBe(false);
  });

  it('classifies raw network errors (ECONNRESET / undici causes) as ambiguous', () => {
    const ecoNNREST = new Error('socket hang up');
    (ecoNNREST as Error & { code?: string }).code = 'ECONNRESET';
    expect(isRetriable(ecoNNREST, true)).toBe(true);
    expect(isRetriable(ecoNNREST, false)).toBe(false);

    const wrapped = new Error('fetch failed');
    (wrapped as Error & { cause?: unknown }).cause = { code: 'UND_ERR_CONNECT_TIMEOUT' };
    expect(isRetriable(wrapped, true)).toBe(true);
  });
});

describe('withDigitalOceanRetry', () => {
  it('returns the value on first success', async () => {
    const out = await withDigitalOceanRetry(
      { method: 'unit', retryOnAmbiguous: true, onRetry: () => {} },
      async () => 42,
    );
    expect(out).toBe(42);
  });

  it('retries on a 429 then succeeds', async () => {
    let calls = 0;
    const out = await withDigitalOceanRetry(
      {
        method: 'unit',
        retryOnAmbiguous: false,
        // Skip the real 1s/2s/4s backoff so the test stays fast.
        backoffMs: [1, 1, 1],
        onRetry: () => {},
      },
      async () => {
        calls += 1;
        if (calls === 1) throw new DigitalOceanApiError(429, 'rate_limit_exceeded', 'Slow down');
        return 'ok';
      },
    );
    expect(out).toBe('ok');
    expect(calls).toBe(2);
  });

  it('does not retry a 401 even when retryOnAmbiguous is true', async () => {
    let calls = 0;
    await expect(
      withDigitalOceanRetry(
        { method: 'unit', retryOnAmbiguous: true, backoffMs: [1, 1, 1], onRetry: () => {} },
        async () => {
          calls += 1;
          throw new DigitalOceanApiError(401, 'unauthorized', 'nope');
        },
      ),
    ).rejects.toBeInstanceOf(DigitalOceanApiError);
    expect(calls).toBe(1);
  });

  it('throws the last error after exhausting attempts', async () => {
    let calls = 0;
    await expect(
      withDigitalOceanRetry(
        { method: 'unit', retryOnAmbiguous: true, backoffMs: [1, 1, 1], onRetry: () => {} },
        async () => {
          calls += 1;
          throw new DigitalOceanApiError(502, 'http_502', 'still bad');
        },
      ),
    ).rejects.toMatchObject({ statusCode: 502 });
    expect(calls).toBe(4); // 1 initial + 3 retries (backoff length).
  });
});
