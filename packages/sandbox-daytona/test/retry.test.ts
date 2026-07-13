import { describe, expect, it, vi } from 'vitest';
import {
  DaytonaAuthenticationError,
  DaytonaConflictError,
  DaytonaConnectionError,
  DaytonaError,
  DaytonaNotFoundError,
  DaytonaRateLimitError,
  DaytonaTimeoutError,
  DaytonaValidationError,
} from '@daytona/sdk';
import { isRetriable, withDaytonaRetry } from '../src/retry.js';

describe('isRetriable', () => {
  it('always retries DaytonaRateLimitError', () => {
    const err = new DaytonaRateLimitError('too many requests', 429);
    expect(isRetriable(err, true)).toBe(true);
    expect(isRetriable(err, false)).toBe(true);
  });

  it('retries DaytonaConnectionError only when ambiguous allowed', () => {
    const err = new DaytonaConnectionError('connect ECONNRESET');
    expect(isRetriable(err, true)).toBe(true);
    expect(isRetriable(err, false)).toBe(false);
  });

  it('retries DaytonaTimeoutError only when ambiguous allowed', () => {
    const err = new DaytonaTimeoutError('timed out');
    expect(isRetriable(err, true)).toBe(true);
    expect(isRetriable(err, false)).toBe(false);
  });

  it('retries DaytonaError with 5xx status only when ambiguous allowed', () => {
    const err504 = new DaytonaError('gateway timeout', 504);
    expect(isRetriable(err504, true)).toBe(true);
    expect(isRetriable(err504, false)).toBe(false);
    const err503 = new DaytonaError('service unavailable', 503);
    expect(isRetriable(err503, true)).toBe(true);
    const err502 = new DaytonaError('bad gateway', 502);
    expect(isRetriable(err502, true)).toBe(true);
  });

  it('never retries permanent 4xx errors', () => {
    expect(isRetriable(new DaytonaNotFoundError('not found', 404), true)).toBe(false);
    expect(isRetriable(new DaytonaAuthenticationError('unauthorized', 401), true)).toBe(false);
    expect(isRetriable(new DaytonaValidationError('bad request', 400), true)).toBe(false);
    expect(isRetriable(new DaytonaConflictError('conflict', 409), true)).toBe(false);
  });

  it('never retries DaytonaError with unknown / 4xx status code', () => {
    expect(isRetriable(new DaytonaError('teapot', 418), true)).toBe(false);
    expect(isRetriable(new DaytonaError('no status'), true)).toBe(false);
  });

  it('retries axios-style ECONNRESET / ETIMEDOUT when ambiguous allowed', () => {
    expect(isRetriable({ code: 'ECONNRESET', message: 'reset' }, true)).toBe(true);
    expect(isRetriable({ code: 'ECONNRESET', message: 'reset' }, false)).toBe(false);
    expect(isRetriable({ code: 'ETIMEDOUT', message: 'timeout' }, true)).toBe(true);
    expect(isRetriable({ code: 'EAI_AGAIN', message: 'dns' }, true)).toBe(true);
  });

  it('retries axios-style 5xx response when ambiguous allowed', () => {
    expect(isRetriable({ response: { status: 502 } }, true)).toBe(true);
    expect(isRetriable({ response: { status: 503 } }, false)).toBe(false);
    expect(isRetriable({ status: 504 }, true)).toBe(true);
    expect(isRetriable({ statusCode: 500 }, true)).toBe(true);
  });

  it('does not retry random thrown values', () => {
    expect(isRetriable('boom', true)).toBe(false);
    expect(isRetriable(undefined, true)).toBe(false);
    expect(isRetriable(new Error('plain'), true)).toBe(false);
  });
});

describe('withDaytonaRetry', () => {
  it('retries until success on transient 504s and returns the final value', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withDaytonaRetry(
      {
        method: 'test',
        retryOnAmbiguous: true,
        backoffMs: [1, 1, 1],
        attemptTimeoutMs: 1000,
        onRetry,
      },
      async () => {
        calls += 1;
        if (calls < 3) throw new DaytonaError('gateway timeout', 504);
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0]![0]).toMatch(/attempt 1 failed/);
    expect(onRetry.mock.calls[1]![0]).toMatch(/attempt 2 failed/);
  });

  it('does not retry on a 404 — surfaces the original typed error', async () => {
    let calls = 0;
    const original = new DaytonaNotFoundError('missing', 404);
    await expect(
      withDaytonaRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1, 1], onRetry: () => {} },
        async () => {
          calls += 1;
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it('does not retry on 504 when retryOnAmbiguous=false', async () => {
    let calls = 0;
    const original = new DaytonaError('gateway timeout', 504);
    await expect(
      withDaytonaRetry(
        { method: 'test', retryOnAmbiguous: false, backoffMs: [1, 1, 1], onRetry: () => {} },
        async () => {
          calls += 1;
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it('enforces per-attempt timeout, retries the synthetic timeout, surfaces it on exhaustion', async () => {
    let calls = 0;
    await expect(
      withDaytonaRetry(
        {
          method: 'test',
          retryOnAmbiguous: true,
          backoffMs: [1, 1],
          attemptTimeoutMs: 50,
          onRetry: () => {},
        },
        async () => {
          calls += 1;
          // Never resolves; the per-attempt timer fires.
          await new Promise(() => {});
        },
      ),
    ).rejects.toThrow(/per-attempt timeout after 50ms/);
    // backoffMs.length + 1 = 3 attempts
    expect(calls).toBe(3);
  });

  it('passes through the first-attempt result when no error', async () => {
    const onRetry = vi.fn();
    const result = await withDaytonaRetry(
      { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1, 1], onRetry },
      async () => 42,
    );
    expect(result).toBe(42);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('surfaces the original error after exhausting all retries', async () => {
    let calls = 0;
    const original = new DaytonaError('gateway timeout', 504);
    await expect(
      withDaytonaRetry(
        {
          method: 'test',
          retryOnAmbiguous: true,
          backoffMs: [1, 1],
          attemptTimeoutMs: 1000,
          onRetry: () => {},
        },
        async () => {
          calls += 1;
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(calls).toBe(3);
  });
});
