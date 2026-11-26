import { describe, expect, it, vi } from 'vitest';
import type { AccountSwitchRecord, AgentSyncSpec, BoxRecord } from '@agentbox/core';
import {
  isSwitchingAccount,
  loginSwitchRefusal,
  switchBoxAccount,
  tokenShapeProblem,
  withRecordAccounts,
  type AccountSwitchDeps,
} from '../lib/backend/account-switch';

const SPEC = {
  id: 'claude',
  credential: { liveReload: true, bindMountable: true },
  accountEnv: { 'api-key': 'ANTHROPIC_API_KEY', 'setup-token': 'CLAUDE_CODE_OAUTH_TOKEN' },
  accountTokenPattern: { 'setup-token': '^sk-ant-oat01-[A-Za-z0-9_-]{60,}$' },
} as unknown as AgentSyncSpec;
const GOOD = `sk-ant-oat01-${'a'.repeat(80)}`;

function box(o: Partial<BoxRecord> = {}): BoxRecord {
  return {
    id: 'b1',
    name: 'web',
    provider: 'docker',
    agents: ['claude'],
    credentialFiles: ['claude'],
    ...o,
  } as BoxRecord;
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
    writeLogin: vi.fn(async (_b: BoxRecord, _a: string, account: string) => {
      calls.push(`write:${account}`);
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

  it('a login on docker: records, then writes the file, and claude keeps running', async () => {
    const { d, calls } = deps();
    const r = await switchBoxAccount(d, 'web', { account: 'work' });
    expect(r).toMatchObject({ kind: 'ok', how: 'file', restarted: false });
    expect(calls).toEqual(['record:default>work:file:manual', 'register', 'write:work']);
  });

  it('a login on a cloud box takes the same path, no env file, no restart', async () => {
    const { d, calls } = deps({ findBox: async () => box({ provider: 'e2b' }) });
    const r = await switchBoxAccount(d, 'web', { account: 'work' });
    expect(r).toMatchObject({ kind: 'ok', how: 'file', restarted: false });
    expect(calls).toEqual(['record:default>work:file:manual', 'register', 'write:work']);
  });

  it('a paused or stopped docker box takes a login (the file is on the host)', async () => {
    const { d, calls } = deps({ boxState: async () => 'paused' });
    expect(await switchBoxAccount(d, 'web', { account: 'work' })).toMatchObject({
      kind: 'ok',
      restarted: false,
    });
    expect(calls).toContain('write:work');
  });

  it('leaving a token for a login restarts the agent, since the env var must go', async () => {
    const { d, calls } = deps({ findBox: async () => box({ accounts: { claude: 'tok' } }) });
    const r = await switchBoxAccount(d, 'web', { account: 'work' });
    expect(r).toMatchObject({ kind: 'ok', how: 'file', restarted: true });
    expect(calls).toEqual(['record:tok>work:file:manual', 'register', 'write:work', 'restart']);
  });

  it('an agent that does not re-read its file is restarted after a login switch', async () => {
    const { d, calls } = deps({
      findBox: async () => box({ provider: 'hetzner' }),
      agentSpec: () => ({ ...SPEC, credential: {} }) as AgentSyncSpec,
    });
    await switchBoxAccount(d, 'web', { account: 'work' });
    expect(calls.at(-1)).toBe('restart');
  });

  it('a failed write puts the record and the old login back', async () => {
    const { d, calls } = deps({
      writeLogin: async (_b, _a, account) => {
        calls.push(`write:${account}`);
        if (account === 'work') throw new Error('disk full');
      },
    });
    expect(await switchBoxAccount(d, 'web', { account: 'work' })).toEqual({
      kind: 'error',
      error: 'could not write the work login into web, so it stays on default: disk full',
    });
    expect(calls).toEqual([
      'record:default>work:file:manual',
      'register',
      'write:work',
      'revert',
      'register',
      'write:default',
    ]);
  });

  it('refuses a docker box without its own file and a cloud box that is not running', () => {
    expect(loginSwitchRefusal(box({ credentialFiles: undefined }), SPEC, 'running')).toMatch(
      /destroy and create it again/,
    );
    expect(loginSwitchRefusal(box({ provider: 'hetzner' }), SPEC, 'paused')).toMatch(/start it/);
    expect(loginSwitchRefusal(box({ provider: 'hetzner' }), SPEC, 'running')).toBeNull();
    expect(loginSwitchRefusal(box(), SPEC, 'stopped')).toBeNull();
    const codex = { id: 'codex', credential: {} } as AgentSyncSpec;
    expect(loginSwitchRefusal(box(), codex, 'running')).toMatch(/use an API key/);
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

describe('switch review fixes (#486)', () => {
  it('a cloud box leaving a token for the default login rewrites its env file and restarts', async () => {
    const { d, calls } = deps({
      findBox: async () => box({ provider: 'hetzner', accounts: { claude: 'tok' } }),
    });
    const r = await switchBoxAccount(d, 'web', { account: 'default' });
    expect(r).toMatchObject({ kind: 'ok', to: 'default', how: 'file' });
    expect(calls).toEqual([
      'record:tok>default:file:manual',
      'register',
      'write:default',
      'env-file',
      'restart',
    ]);
  });

  it('a registration back on default drops the named account it left', () => {
    expect(
      withRecordAccounts<{ boxId: string; accounts?: Record<string, string> }>(
        { boxId: 'b1', accounts: { claude: 'work' } },
        {},
      ),
    ).toEqual({
      boxId: 'b1',
    });
    expect(
      withRecordAccounts<{ boxId: string; accounts?: Record<string, string> }>(
        { boxId: 'b1' },
        { accounts: { claude: 'tok' } },
      ),
    ).toEqual({
      boxId: 'b1',
      accounts: { claude: 'tok' },
    });
  });

  it('marks the box as switching while the switch runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { d } = deps({ restartAgent: () => gate });
    const p = switchBoxAccount(d, 'web', { account: 'tok' });
    await new Promise((r) => setTimeout(r, 0));
    expect(isSwitchingAccount('b1')).toBe(true);
    release();
    await p;
    expect(isSwitchingAccount('b1')).toBe(false);
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
