import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { appJwt, GitHubAppLeaser, type GitHubAppConfig } from '../src/github-app.js';

// A throwaway RSA keypair so the test signs/verifies a real RS256 JWT without
// any GitHub network access.
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const cfg: GitHubAppConfig = {
  appId: '123456',
  privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
};

function decodeJwtPart(part: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('appJwt', () => {
  it('produces an RS256 JWT with the App id and a <10min expiry', () => {
    const nowMs = 1_700_000_000_000;
    const jwt = appJwt(cfg, nowMs);
    const [h, p, sig] = jwt.split('.');
    expect(decodeJwtPart(h!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const payload = decodeJwtPart(p!) as { iss: string; iat: number; exp: number };
    expect(payload.iss).toBe('123456');
    expect(payload.iat).toBe(Math.floor(nowMs / 1000) - 60);
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(600);
    expect(sig && sig.length).toBeGreaterThan(0);
  });
});

describe('GitHubAppLeaser', () => {
  interface Call {
    url: string;
    method: string;
    body?: string;
  }

  function makeFetch(calls: Call[], expiresAt: string): typeof fetch {
    return (async (input: unknown, init?: { method?: string; body?: unknown }) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body as string | undefined });
      if (url.endsWith('/installation')) {
        return new Response(JSON.stringify({ id: 999 }), { status: 200 });
      }
      if (url.endsWith('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: expiresAt }), {
          status: 201,
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('leases a repo-scoped token with minimal perms', async () => {
    const calls: Call[] = [];
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const leaser = new GitHubAppLeaser(cfg, { fetchImpl: makeFetch(calls, future) });

    const leased = await leaser.leaseRepoToken('acme', 'widgets');
    expect(leased.token).toBe('ghs_minted');

    const tokenCall = calls.find((c) => c.url.endsWith('/access_tokens'));
    expect(tokenCall?.method).toBe('POST');
    const body = JSON.parse(tokenCall!.body!) as {
      repositories: string[];
      permissions: Record<string, string>;
    };
    expect(body.repositories).toEqual(['widgets']); // single repo, scoped tight
    expect(body.permissions).toEqual({ contents: 'write', pull_requests: 'write' });
    expect(calls.find((c) => c.url.includes('/repos/acme/widgets/installation'))).toBeTruthy();
  });

  it('caches the token until ~5 min before expiry (no re-mint)', async () => {
    const calls: Call[] = [];
    let clock = 1_700_000_000_000;
    const expiresAt = new Date(clock + 60 * 60 * 1000).toISOString(); // +1h
    const leaser = new GitHubAppLeaser(cfg, {
      fetchImpl: makeFetch(calls, expiresAt),
      now: () => clock,
    });

    await leaser.leaseRepoToken('acme', 'widgets');
    const mintsAfterFirst = calls.filter((c) => c.url.endsWith('/access_tokens')).length;
    expect(mintsAfterFirst).toBe(1);

    // 50 min later: still >5 min of life → served from cache, no new mint.
    clock += 50 * 60 * 1000;
    await leaser.leaseRepoToken('acme', 'widgets');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens')).length).toBe(1);

    // 58 min in: <5 min left → re-mint.
    clock += 8 * 60 * 1000;
    await leaser.leaseRepoToken('acme', 'widgets');
    expect(calls.filter((c) => c.url.endsWith('/access_tokens')).length).toBe(2);
  });

  it('throws a clear error when the App is not installed on the repo', async () => {
    const fetchImpl = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    const leaser = new GitHubAppLeaser(cfg, { fetchImpl });
    await expect(leaser.leaseRepoToken('acme', 'widgets')).rejects.toThrow(/not installed/);
  });
});
