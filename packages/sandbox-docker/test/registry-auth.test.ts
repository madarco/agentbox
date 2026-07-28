import { describe, expect, it } from 'vitest';
import {
  classifyPullFailure,
  isAuthRetryable,
  isGhcrTarget,
  loginToGhcrWithGh,
} from '../src/registry-auth.js';

describe('classifyPullFailure', () => {
  it('recognizes a GHCR anonymous rate limit', () => {
    const r = classifyPullFailure(
      'Error response from daemon: toomanyrequests: retry-after 313.5s, allowed: 44000/minute',
    );
    expect(r.kind).toBe('rate-limit');
    expect(r.detail).toContain('toomanyrequests');
  });

  it('recognizes an unpublished tag as not-found, NOT as auth', () => {
    // The distinction that matters: not-found means "build locally" and must
    // never trigger a login attempt.
    for (const text of [
      'Error response from daemon: manifest unknown',
      'Error response from daemon: manifest for ghcr.io/x/box:sha-deadbeef not found',
    ]) {
      const r = classifyPullFailure(text);
      expect(r.kind).toBe('not-found');
      expect(isAuthRetryable(r.kind)).toBe(false);
    }
  });

  it('recognizes rejected credentials', () => {
    expect(classifyPullFailure('denied: denied').kind).toBe('unauthorized');
    expect(classifyPullFailure('unauthorized: authentication required').kind).toBe('unauthorized');
  });

  it('recognizes transport failures', () => {
    expect(classifyPullFailure('dial tcp: lookup ghcr.io: no such host').kind).toBe('network');
    expect(classifyPullFailure('net/http: TLS handshake timeout').kind).toBe('network');
  });

  it('classifies a rate limit ahead of the "unauthorized" it also mentions', () => {
    // GHCR's throttle response can carry both words; only the throttle reading
    // makes an authenticated retry worth doing.
    const r = classifyPullFailure('unauthorized: toomanyrequests: too many requests');
    expect(r.kind).toBe('rate-limit');
  });

  it('falls back to unknown, and never throws on empty stderr', () => {
    const r = classifyPullFailure('');
    expect(r.kind).toBe('unknown');
    expect(r.detail).toMatch(/no error output/);
  });

  it('reports the last meaningful line as the detail', () => {
    const r = classifyPullFailure(
      'pulling layer\n\nError response from daemon: denied: denied\n\n',
    );
    expect(r.detail).toBe('Error response from daemon: denied: denied');
  });
});

describe('isAuthRetryable / isGhcrTarget', () => {
  it('only retries throttles and credential failures', () => {
    expect(isAuthRetryable('rate-limit')).toBe(true);
    expect(isAuthRetryable('unauthorized')).toBe(true);
    expect(isAuthRetryable('not-found')).toBe(false);
    expect(isAuthRetryable('network')).toBe(false);
    expect(isAuthRetryable('unknown')).toBe(false);
  });

  it('only claims GHCR targets', () => {
    expect(isGhcrTarget('ghcr.io/madarco/agentbox/box:sha-abc')).toBe(true);
    expect(isGhcrTarget('docker.io/library/node:22')).toBe(false);
    expect(isGhcrTarget('myghcr.io.evil.example/x:1')).toBe(false);
  });
});

describe('loginToGhcrWithGh', () => {
  const runner =
    (map: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) =>
    async (file: string, args: string[]) => {
      const key = `${file} ${args[0]}`;
      const r = map[key] ?? { exitCode: 127, stderr: `unexpected ${key}` };
      return { exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
    };

  it('logs in when the gh token carries read:packages', async () => {
    const res = await loginToGhcrWithGh({
      run: runner({
        'gh auth': { exitCode: 0, stdout: 'gho_tok\n' },
        'docker login': { exitCode: 0 },
      }),
      fetchScopes: async () => ['repo', 'read:packages'],
    });
    expect(res.ok).toBe(true);
  });

  it('REFUSES to log in when read:packages is missing', async () => {
    // Authenticating with a token that cannot read packages makes GHCR answer
    // 403 where anonymous would have succeeded — strictly worse than not trying.
    let loginAttempted = false;
    const res = await loginToGhcrWithGh({
      run: async (file, args) => {
        if (file === 'docker' && args[0] === 'login') loginAttempted = true;
        return file === 'gh'
          ? { exitCode: 0, stdout: 'gho_tok', stderr: '' }
          : { exitCode: 0, stdout: '', stderr: '' };
      },
      fetchScopes: async () => ['repo', 'workflow'],
    });
    expect(res.ok).toBe(false);
    expect(loginAttempted).toBe(false);
    expect(res.reason).toContain('read:packages');
    expect(res.reason).toContain('gh auth refresh');
  });

  it('still tries when the scope list is unknown (fine-grained PAT)', async () => {
    const res = await loginToGhcrWithGh({
      run: runner({
        'gh auth': { exitCode: 0, stdout: 'ghp_fine' },
        'docker login': { exitCode: 0 },
      }),
      fetchScopes: async () => [],
    });
    expect(res.ok).toBe(true);
  });

  it('reports when gh has no token', async () => {
    const res = await loginToGhcrWithGh({
      run: runner({ 'gh auth': { exitCode: 1, stderr: 'not logged in' } }),
      fetchScopes: async () => [],
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('gh auth login');
  });

  it('surfaces a docker login failure', async () => {
    const res = await loginToGhcrWithGh({
      run: runner({
        'gh auth': { exitCode: 0, stdout: 'gho_tok' },
        'docker login': { exitCode: 1, stderr: 'Error: login attempt failed' },
      }),
      fetchScopes: async () => ['read:packages'],
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain('login attempt failed');
  });
});
