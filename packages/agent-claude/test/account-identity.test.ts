import { describe, expect, it } from 'vitest';
import { parseClaudeAccountIdentity } from '../src/cli/account-identity.js';
import { ACCOUNT_STATE_KEYS, stripAccountState } from '../src/hooks-filter.js';

describe('parseClaudeAccountIdentity', () => {
  it('reads plan from the credential and email/org from oauthAccount', () => {
    expect(
      parseClaudeAccountIdentity({
        '.credentials.json': JSON.stringify({ claudeAiOauth: { subscriptionType: 'max' } }),
        '_claude.json': JSON.stringify({
          oauthAccount: { emailAddress: 'b@example.com', organizationName: 'Org B' },
        }),
      }),
    ).toEqual({ email: 'b@example.com', org: 'Org B', plan: 'max' });
  });

  it('is undefined with nothing to show, and tolerates garbage', () => {
    expect(parseClaudeAccountIdentity({ '.credentials.json': null, '_claude.json': null })).toBe(
      undefined,
    );
    expect(parseClaudeAccountIdentity({ '.credentials.json': '{bad', '_claude.json': '[]' })).toBe(
      undefined,
    );
  });
});

describe('stripAccountState', () => {
  it("drops the host's account state and keeps the user's config", () => {
    const host = {
      installMethod: 'native',
      projects: { '/workspace': { hasTrustDialogAccepted: true } },
      oauthAccount: { emailAddress: 'owner@example.com' },
      customApiKeyResponses: { approved: ['x'] },
      modelAccessCache: {},
      primaryApiKey: 'sk-ant-api03-owner',
    };
    const r = stripAccountState(host);
    expect(r.stripped).toBe(true);
    expect(r.data).toEqual({
      installMethod: 'native',
      projects: { '/workspace': { hasTrustDialogAccepted: true } },
    });
    for (const k of ACCOUNT_STATE_KEYS) expect(k in (r.data as object)).toBe(false);
  });

  it('is a no-op when there is no account state', () => {
    const r = stripAccountState({ installMethod: 'native' });
    expect(r).toEqual({ data: { installMethod: 'native' }, stripped: false });
    expect(stripAccountState(null).stripped).toBe(false);
  });
});

describe('accountStateJqDelete', () => {
  it('deletes every account-state key, primaryApiKey included', async () => {
    const { accountStateJqDelete } = await import('../src/docker-sync.js');
    const prog = accountStateJqDelete();
    for (const k of ACCOUNT_STATE_KEYS) expect(prog).toContain(`.${k}`);
    expect(prog).toContain('.primaryApiKey');
    expect(prog).not.toMatch(/'/);
  });
});
