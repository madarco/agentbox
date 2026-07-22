import { describe, expect, it, vi } from 'vitest';
import { isRetriable, withTenkiRetry } from '../src/retry.js';

/** Build an Error whose `.name` matches one of the SDK's typed error classes. */
function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

describe('isRetriable', () => {
  it('always retries RateLimitedError / CapacityUnavailableError', () => {
    for (const n of ['RateLimitedError', 'CapacityUnavailableError']) {
      expect(isRetriable(named(n), true)).toBe(true);
      expect(isRetriable(named(n), false)).toBe(true);
    }
  });

  it('never retries terminal typed errors', () => {
    for (const n of [
      'UnauthorizedError',
      'PermissionDeniedError',
      'MissingAuthTokenError',
      'SessionNotFoundError',
      'SnapshotNotFoundError',
      'QuotaExceededError',
      'InvalidStateError',
      'FileNotFoundError',
    ]) {
      expect(isRetriable(named(n), true)).toBe(false);
    }
  });

  it('retries Connect unavailable / resource_exhausted regardless of ambiguity', () => {
    expect(isRetriable({ code: 'unavailable' }, false)).toBe(true);
    expect(isRetriable({ code: 'resource_exhausted' }, false)).toBe(true);
  });

  it('retries Connect aborted / deadline_exceeded only when ambiguous allowed', () => {
    expect(isRetriable({ code: 'deadline_exceeded' }, true)).toBe(true);
    expect(isRetriable({ code: 'deadline_exceeded' }, false)).toBe(false);
    expect(isRetriable({ code: 'aborted' }, true)).toBe(true);
    expect(isRetriable({ code: 'aborted' }, false)).toBe(false);
  });

  it('does not retry non-retriable Connect codes', () => {
    expect(isRetriable({ code: 'permission_denied' }, true)).toBe(false);
    expect(isRetriable({ code: 'invalid_argument' }, true)).toBe(false);
    expect(isRetriable({ code: 'not_found' }, true)).toBe(false);
  });

  it('handles HTTP status codes (429 always, 5xx ambiguous, 4xx never)', () => {
    expect(isRetriable({ statusCode: 429 }, false)).toBe(true);
    expect(isRetriable({ status: 503 }, true)).toBe(true);
    expect(isRetriable({ status: 503 }, false)).toBe(false);
    expect(isRetriable({ statusCode: 404 }, true)).toBe(false);
  });

  it('retries raw socket errors only when ambiguous allowed (not misread as Connect codes)', () => {
    expect(isRetriable({ code: 'ECONNRESET' }, true)).toBe(true);
    expect(isRetriable({ code: 'ECONNRESET' }, false)).toBe(false);
    expect(isRetriable({ code: 'ETIMEDOUT' }, true)).toBe(true);
    expect(isRetriable({ cause: { code: 'UND_ERR_SOCKET' } }, true)).toBe(true);
  });

  it('does not retry random thrown values', () => {
    expect(isRetriable('boom', true)).toBe(false);
    expect(isRetriable(undefined, true)).toBe(false);
    expect(isRetriable(new Error('plain'), true)).toBe(false);
  });
});

describe('withTenkiRetry', () => {
  it('retries a transient Connect unavailable then returns the final value', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await withTenkiRetry(
      { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1, 1], onRetry },
      async () => {
        calls += 1;
        if (calls < 3) throw Object.assign(new Error('blip'), { code: 'unavailable' });
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not retry a terminal typed error — surfaces the original', async () => {
    let calls = 0;
    const original = named('UnauthorizedError');
    await expect(
      withTenkiRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1], onRetry: () => {} },
        async () => {
          calls += 1;
          throw original;
        },
      ),
    ).rejects.toBe(original);
    expect(calls).toBe(1);
  });

  it('enforces the per-attempt timeout, retries it, surfaces it on exhaustion', async () => {
    let calls = 0;
    await expect(
      withTenkiRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1, 1], attemptTimeoutMs: 30, onRetry: () => {} },
        async () => {
          calls += 1;
          await new Promise(() => {});
        },
      ),
    ).rejects.toThrow(/per-attempt timeout after 30ms/);
    expect(calls).toBe(3);
  });

  it('passes through the first-attempt result when no error', async () => {
    const onRetry = vi.fn();
    expect(
      await withTenkiRetry(
        { method: 'test', retryOnAmbiguous: true, backoffMs: [1], onRetry },
        async () => 42,
      ),
    ).toBe(42);
    expect(onRetry).not.toHaveBeenCalled();
  });
});
