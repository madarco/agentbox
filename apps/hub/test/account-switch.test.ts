import { describe, expect, it, vi } from 'vitest';
import type { AccountSwitchRecord, AgentSyncSpec, BoxRecord } from '@agentbox/core';
import {
  switchBoxAccount,
  tokenShapeProblem,
  type AccountSwitchDeps,
} from '../lib/backend/account-switch';

const SPEC = {
  id: 'claude',
  accountEnv: { 'api-key': 'ANTHROPIC_API_KEY', 'setup-token': 'CLAUDE_CODE_OAUTH_TOKEN' },
  accountTokenPattern: { 'setup-token': '^sk-ant-oat01-[A-Za-z0-9_-]{60,}$' },
} as unknown as AgentSyncSpec;
const GOOD = `sk-ant-oat01-${'a'.repeat(80)}`;

function box(o: Partial<BoxRecord> = {}): BoxRecord {
  return { id: 'b1', name: 'web', provider: 'docker', agents: ['claude'], ...o } as BoxRecord;
}

function deps(o: Partial<AccountSwitchDeps> & { kinds?: Record<string, string> } = {}) {
  const calls: string[] = [];
  const kinds = o.kinds ?? { tok: 'setup-token', work: 'login' };
  const d: AccountSwitchDeps = {
    findBox: async () => box(),
    agentSpec: () => SPEC,
    accountKind: async (_a, id) => (kinds[id] as never) ?? null,
    accountInject: async (_a, id): Promise<Record<string, string>> =>
      id === 'tok' ? { CLAUDE_CODE_OAUTH_TOKEN: GOOD } : {},
    boxState: async () => 'running',
    sessionId: async () => 'sess-1',
    recreate: vi.fn(async (b: BoxRecord) => {
      calls.push('recreate');
      return { record: b, recreated: true };
    }),
    rewriteCloudEnv: async () => void calls.push('env-file'),
    restartAgent: async () => void calls.push('restart'),
    recordSwitch: async (_id, e: AccountSwitchRecord) => {
      calls.push(`record:${e.from}>${e.to}:${e.how}:${e.reason}`);
      return undefined;
    },
    reregister: async () => void calls.push('register'),
    revertSwitch: async () => {
      calls.push('revert');
      return undefined;
    },
    now: () => new Date('2026-11-25T00:00:00Z'),
    log: () => {},
    ...o,
  };
  return { d, calls };
}

describe('switchBoxAccount', () => {
  it('a token on docker: records, re-registers and restarts, no recreate', async () => {
    const { d, calls } = deps();
    const r = await switchBoxAccount(d, 'web', { account: 'tok' });
    expect(r).toMatchObject({
      kind: 'ok',
      from: 'default',
      to: 'tok',
      how: 'env',
      restarted: true,
    });
    expect(calls).toEqual(['record:default>tok:env:manual', 'register', 'restart']);
  });

  it('a token on a cloud box rewrites the env file before the restart', async () => {
    const { d, calls } = deps({ findBox: async () => box({ provider: 'hetzner' }) });
    await switchBoxAccount(d, 'web', { account: 'tok', reason: 'limit' });
    expect(calls).toEqual(['record:default>tok:env:limit', 'register', 'env-file', 'restart']);
  });

  it('a stopped box is recorded only; the switch applies at its next start', async () => {
    const { d, calls } = deps({ boxState: async () => 'stopped' });
    const r = await switchBoxAccount(d, 'web', { account: 'tok' });
    expect(r).toMatchObject({ kind: 'ok', restarted: false });
    expect(calls).toEqual(['record:default>tok:env:manual', 'register']);
  });

  it('refuses a malformed token without echoing it', async () => {
    const { d, calls } = deps({
      accountInject: async () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-short' }),
    });
    const r = await switchBoxAccount(d, 'web', { account: 'tok' });
    expect(r.kind).toBe('invalid');
    expect(JSON.stringify(r)).not.toContain('sk-ant-oat01-short');
    expect(calls).toEqual([]);
  });

  it('a login on docker recreates, then restarts the agent', async () => {
    const { d, calls } = deps();
    const r = await switchBoxAccount(d, 'web', { account: 'work' });
    expect(r).toMatchObject({ kind: 'ok', how: 'recreate' });
    expect(d.recreate).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ account: 'work', sessionId: 'sess-1' }),
    );
    expect(calls).toEqual([
      'recreate',
      'record:default>work:recreate:manual',
      'register',
      'restart',
    ]);
  });

  it('a login on a cloud box is refused with the agreed message', async () => {
    const { d, calls } = deps({ findBox: async () => box({ provider: 'e2b' }) });
    const r = await switchBoxAccount(d, 'web', { account: 'work' });
    expect(r).toEqual({
      kind: 'refused',
      error:
        'switching a cloud box to another login is not supported yet; use a setup token or API key',
    });
    expect(calls).toEqual([]);
  });

  it('a paused docker box is refused for a login', async () => {
    const { d } = deps({ boxState: async () => 'paused' });
    expect((await switchBoxAccount(d, 'web', { account: 'work' })).kind).toBe('refused');
  });

  it('rejects an unknown account, the current account and an agent the box lacks', async () => {
    const { d } = deps();
    expect((await switchBoxAccount(d, 'web', { account: 'nope' })).kind).toBe('invalid');
    expect((await switchBoxAccount(d, 'web', { account: 'default' })).kind).toBe('invalid');
    expect((await switchBoxAccount(d, 'web', { account: 'tok', agent: 'codex' })).kind).toBe(
      'invalid',
    );
    expect(
      (await switchBoxAccount({ ...d, findBox: async () => null }, 'x', { account: 'tok' })).kind,
    ).toBe('not_found');
  });

  it('a failed recreate is an error and records nothing', async () => {
    const { d, calls } = deps({
      recreate: async () => {
        throw new Error('docker said no');
      },
    });
    expect(await switchBoxAccount(d, 'web', { account: 'work' })).toEqual({
      kind: 'error',
      error: 'docker said no',
    });
    expect(calls).toEqual([]);
  });
});

describe('switchBoxAccount failures', () => {
  it('a token switch whose restart fails reverts the record and restarts on the old account', async () => {
    let n = 0;
    const { d, calls } = deps({
      restartAgent: async () => {
        calls.push('restart');
        if (n++ === 0) throw new Error('tmux died');
      },
    });
    const r = await switchBoxAccount(d, 'web', { account: 'tok' });
    expect(r).toEqual({
      kind: 'error',
      error: 'could not restart claude on tok, so the box stays on default: tmux died',
    });
    expect(calls).toEqual([
      'record:default>tok:env:manual',
      'register',
      'restart',
      'revert',
      'register',
      'restart',
    ]);
  });

  it('refuses a second switch of a box while one runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps({ restartAgent: () => gate });
    const first = switchBoxAccount(d, 'web', { account: 'tok' });
    await new Promise((r) => setTimeout(r, 0));
    expect((await switchBoxAccount(d, 'web', { account: 'tok' })).kind).toBe('refused');
    release();
    expect((await first).kind).toBe('ok');
  });
});

describe('tokenShapeProblem', () => {
  it('accepts a real-shaped token and names a missing or malformed one', () => {
    expect(tokenShapeProblem(SPEC, 'setup-token', GOOD)).toBeNull();
    expect(tokenShapeProblem(SPEC, 'setup-token', undefined)).toMatch(/missing/);
    expect(tokenShapeProblem(SPEC, 'setup-token', 'x')).toMatch(/does not look like/);
    expect(tokenShapeProblem(SPEC, 'api-key', 'anything')).toBeNull();
  });
});
