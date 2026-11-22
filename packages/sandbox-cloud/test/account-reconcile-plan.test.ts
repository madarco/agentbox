import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'agentbox-reconcile-plan-'));
const realHome = process.env.HOME;
process.env.HOME = home;
const { accountReconcilePlan } = await import('../src/sync/agent-credentials.js');
const core = await import('@agentbox/sandbox-core');

beforeAll(async () => {
  await core.upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' });
  await core.upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' });
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('accountReconcilePlan (llm-accounts Phase 4)', () => {
  it('a default box reconciles as before', async () => {
    expect(await accountReconcilePlan(undefined)).toEqual({ backups: {}, skip: [] });
  });
  it("a named login reconciles against the account's own secret", async () => {
    expect(await accountReconcilePlan({ claude: 'work' })).toEqual({
      backups: { claude: join(home, '.agentbox', 'credentials', 'claude', 'work.json') },
      skip: [],
    });
  });
  it('a pasted-kind account is left out (a token, no login file)', async () => {
    expect(await accountReconcilePlan({ claude: 'ci' })).toEqual({ backups: {}, skip: ['claude'] });
  });
  it('an odd record never throws: the agent is skipped, the rest still reconcile', async () => {
    const plan = await accountReconcilePlan({ claude: 'work', 'gone-agent': 'x' });
    expect(plan.backups['claude']).toBeDefined();
    expect(plan.skip).toEqual(['gone-agent']);
  });
});
