import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.HOME = mkdtempSync(join(tmpdir(), 'agentbox-session-env-'));

const { describe, expect, it } = await import('vitest');
const { sessionAccountPolicy } = await import('../src/sync/account-session-env.js');

describe('sessionAccountPolicy', () => {
  it("fails closed: an unreadable registry forwards none of the agent's account keys", async () => {
    const policy = await sessionAccountPolicy('claude', 'agentbox-x', () =>
      Promise.reject(new Error('EACCES')),
    );
    expect(policy.inject).toEqual({});
    expect(policy.suppress.sort()).toEqual(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']);
  });

  it('a box on its default account forwards everything', async () => {
    const policy = await sessionAccountPolicy('claude', 'agentbox-x', () =>
      Promise.resolve({ version: 1, boxes: [] } as never),
    );
    expect(policy).toEqual({ inject: {}, suppress: [] });
  });

  it('an unknown agent has no account keys to hold back', async () => {
    const policy = await sessionAccountPolicy('nope', 'agentbox-x', () =>
      Promise.reject(new Error('x')),
    );
    expect(policy).toEqual({ inject: {}, suppress: [] });
  });
});
