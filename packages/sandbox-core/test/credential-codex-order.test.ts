import { describe, expect, it } from 'vitest';
import { shouldAcceptCredentialUpdate } from '../src/sync/concerns/credentials.js';

/** A fake codex auth.json: no freshness field, ordered by the access token's JWT `exp`. */
const codexAuth = (exp: number, tag: string) => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return JSON.stringify({
    tokens: {
      access_token: `${b64({ alg: 'none' })}.${b64({ exp })}.sig`,
      refresh_token: `fake-rt-${tag}`,
      account_id: 'acct-1',
    },
  });
};

describe('shouldAcceptCredentialUpdate orders codex by its JWT exp (#528 review)', () => {
  it("refuses an older copy that merely differs (the custody seed, a stale box's post)", () => {
    expect(
      shouldAcceptCredentialUpdate('codex', codexAuth(100, 'old'), codexAuth(200, 'live')),
    ).toMatchObject({ accept: false });
    expect(
      shouldAcceptCredentialUpdate('codex', codexAuth(300, 'new'), codexAuth(200, 'live')),
    ).toMatchObject({ accept: true });
  });

  it('keeps last-writer-wins when either copy has no token to order by', () => {
    const plain = JSON.stringify({ OPENAI_API_KEY: 'sk-fake' });
    expect(shouldAcceptCredentialUpdate('codex', plain, codexAuth(200, 'live')).accept).toBe(true);
  });
});
