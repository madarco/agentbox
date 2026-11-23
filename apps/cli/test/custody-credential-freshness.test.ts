import { describe, expect, it } from 'vitest';
import {
  credentialPushVerdict,
  planCredentialPush,
  sha256Hex,
  type CustodyEntry,
} from '../src/control-plane/custody-client.js';

// Pure — no HOME, no network. The bug: a hub box refreshed claude's login (which
// revokes the old one), then the next hub-routed create from the PC pushed the
// PC's older, revoked copy over it and every new hub box started logged out.

const NOW = 1_800_000_000_000;
const claude = (expiresAt: number): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt } });
const jwt = (expSec: number): string =>
  `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString('base64url')}.s`;
const codex = (expSec: number): string =>
  JSON.stringify({ tokens: { access_token: jwt(expSec), refresh_token: 'r' } });

function entry(path: string, data: string): CustodyEntry {
  const b = Buffer.from(data);
  return { path, size: b.length, sha256: sha256Hex(b), mode: 0o600, updatedAt: '' };
}

describe('credentialPushVerdict', () => {
  it("keeps custody's claude login when it is newer than this PC's", () => {
    expect(credentialPushVerdict('claude', claude(NOW + 1000), claude(NOW + 9000), NOW)).toEqual({
      upload: false,
      reason: 'custody copy is newer',
    });
    expect(
      credentialPushVerdict('claude', claude(NOW + 9000), claude(NOW + 1000), NOW).upload,
    ).toBe(true);
  });

  it('compares a codex login by its access-token JWT exp', () => {
    const s = NOW / 1000;
    expect(credentialPushVerdict('codex', codex(s + 10), codex(s + 90), NOW).upload).toBe(false);
    expect(credentialPushVerdict('codex', codex(s + 90), codex(s + 10), NOW).upload).toBe(true);
  });

  it('never replaces a live login with an expired one', () => {
    expect(credentialPushVerdict('claude', claude(NOW - 1), claude(NOW + 5), NOW)).toEqual({
      upload: false,
      reason: 'this copy has expired',
    });
  });

  it('falls back to last-writer-wins when either side has no readable expiry', () => {
    expect(credentialPushVerdict('claude', claude(NOW + 5), '{"x":1}', NOW).upload).toBe(true);
    // Switched codex to an API-key auth.json: a different login, not an older one.
    const apiKey = JSON.stringify({ OPENAI_API_KEY: 'k', tokens: null });
    expect(credentialPushVerdict('codex', apiKey, codex(NOW / 1000 + 90), NOW).upload).toBe(true);
  });
});

describe('planCredentialPush', () => {
  const path = 'agents/claude/.credentials.json';
  const accountPath = 'agents/codex/accounts/pc-1/work/auth.json';

  it('skips a stale default and named-account login, uploads a newer one', async () => {
    const s = NOW / 1000;
    const remote: Record<string, string> = {
      [path]: claude(NOW + 9000),
      [accountPath]: codex(s + 10),
    };
    const items = [
      { path, data: Buffer.from(claude(NOW + 1000)) },
      { path: accountPath, data: Buffer.from(codex(s + 90)) },
    ];
    const plan = await planCredentialPush(
      items,
      Object.entries(remote).map(([p, d]) => entry(p, d)),
      (p) => Promise.resolve(remote[p] ? Buffer.from(remote[p]) : null),
      { now: NOW },
    );
    expect(plan).toEqual([
      { path, action: 'skip', reason: 'custody copy is newer' },
      { path: accountPath, action: 'upload', reason: 'newer login' },
    ]);
  });

  it('uploads a new login and anything under --force without reading custody', async () => {
    const reads: string[] = [];
    const get = (p: string) => {
      reads.push(p);
      return Promise.resolve(Buffer.from(claude(NOW + 9000)));
    };
    const item = { path, data: Buffer.from(claude(NOW + 1)) };
    expect((await planCredentialPush([item], [], get, { now: NOW }))[0]!.action).toBe('upload');
    const forced = await planCredentialPush([item], [entry(path, claude(NOW + 9000))], get, {
      force: true,
      now: NOW,
    });
    expect(forced[0]!.action).toBe('upload');
    expect(reads).toEqual([]);
  });
});
