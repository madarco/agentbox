import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '@agentbox/config';
import type { AgentSyncSpec } from '@agentbox/core';
import {
  accountEnvPolicy,
  applyAccountEnv,
  boxAccount,
  boxesOnAccount,
  parseAccountFlags,
  resolveBoxAccounts,
} from '../src/account-selection.js';
import {
  encodePastedSecret,
  upsertAccount,
  writeAccountSecret,
  type AccountStoreOptions,
} from '../src/llm-accounts.js';
import { resolveAgentSpec } from '../src/sync/registry.js';

let dir: string;
let store: AccountStoreOptions;
const claude = (): AgentSyncSpec => resolveAgentSpec('claude');

const layers = (
  o: { workspace?: object; project?: object; global?: object } = {},
): Pick<LoadedConfig, 'layers'> =>
  ({
    layers: {
      cli: { values: {} },
      workspace: { path: null, values: o.workspace ?? {} },
      project: { path: '/p', values: o.project ?? {} },
      global: { path: '/g', values: o.global ?? {} },
      defaults: {},
    },
  }) as unknown as Pick<LoadedConfig, 'layers'>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'agentbox-acct-sel-'));
  store = {
    path: join(dir, 'accounts.json'),
    stateDir: dir,
    specs: [claude(), resolveAgentSpec('codex')],
  };
  await upsertAccount({ agent: 'claude', id: 'work', kind: 'login', createdAt: 't' }, store);
  await upsertAccount({ agent: 'claude', id: 'ci', kind: 'setup-token', createdAt: 't' }, store);
  await writeAccountSecret(
    'claude',
    'ci',
    encodePastedSecret({ kind: 'setup-token', token: 'sk-ant-oat01-' + 'x'.repeat(20) }),
    store,
  );
  // The legacy backup path must not be touched by any of this.
  writeFileSync(join(dir, 'unrelated'), '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parseAccountFlags', () => {
  it('a bare name means the command agent; <agent>=<name> any agent', () => {
    expect(parseAccountFlags(['work'], 'claude')).toEqual({ claude: 'work' });
    expect(parseAccountFlags(['claude=work', 'codex=b'])).toEqual({ claude: 'work', codex: 'b' });
    expect(parseAccountFlags(['claude-code=work'])).toEqual({ claude: 'work' });
  });
  it('refuses a bare name without an agent, a bad id, an unknown agent, a conflict', () => {
    expect(() => parseAccountFlags(['work'])).toThrow(/<agent>=<name>/);
    expect(() => parseAccountFlags(['claude=Work'])).toThrow(/lowercase/);
    expect(() => parseAccountFlags(['nope=work'])).toThrow(/unknown agent/);
    expect(() => parseAccountFlags(['claude=a', 'claude=b'])).toThrow(/two accounts/);
  });
});

describe('resolveBoxAccounts', () => {
  it('flag > project > global > default, named accounts only', async () => {
    const cfg = layers({
      project: { claude: { account: 'ci' } },
      global: { claude: { account: 'work' } },
    });
    expect((await resolveBoxAccounts({ agents: ['claude'], config: cfg, store })).accounts).toEqual(
      {
        claude: 'ci',
      },
    );
    expect(
      (
        await resolveBoxAccounts({
          agents: ['claude'],
          flags: { claude: 'work' },
          config: cfg,
          store,
        })
      ).accounts,
    ).toEqual({ claude: 'work' });
    expect(
      (
        await resolveBoxAccounts({
          agents: ['claude'],
          config: layers({ global: { claude: { account: 'work' } } }),
          store,
        })
      ).accounts,
    ).toEqual({ claude: 'work' });
    expect(
      (await resolveBoxAccounts({ agents: ['claude'], config: layers(), store })).accounts,
    ).toEqual({});
  });

  it("never reads the repo's agentbox.yaml, and says so", async () => {
    const r = await resolveBoxAccounts({
      agents: ['claude'],
      config: layers({ workspace: { claude: { account: 'work' } } }),
      store,
    });
    expect(r.accounts).toEqual({});
    expect(r.warnings.join('\n')).toMatch(/ignoring claude.account from agentbox.yaml/);
  });

  it('refuses a missing account, a flag for an agent the box is not for, and a pasted lender', async () => {
    await expect(
      resolveBoxAccounts({ agents: ['claude'], flags: { claude: 'nope' }, store }),
    ).rejects.toThrow(/no claude account 'nope'/);
    await expect(
      resolveBoxAccounts({ agents: ['claude'], flags: { codex: 'work' }, store }),
    ).rejects.toThrow(/does not carry codex/);
    await expect(
      resolveBoxAccounts({
        agents: ['claude'],
        flags: { claude: 'ci' },
        loginOnly: ['claude'],
        store,
      }),
    ).rejects.toThrow(/needs a login account/);
  });

  it('an agent without accounts cannot be given one', async () => {
    await expect(
      resolveBoxAccounts({
        agents: ['opencode'],
        config: layers({ global: { opencode: { account: 'x' } } }),
        store,
      }),
    ).rejects.toThrow(/does not support named accounts/);
  });
});

describe('accountEnvPolicy / applyAccountEnv', () => {
  const host = {
    ANTHROPIC_API_KEY: 'host-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'host-tok',
    CLAUDE_EFFORT: 'high',
  };

  it('default leaves the spray alone', async () => {
    expect(applyAccountEnv(host, await accountEnvPolicy(claude(), 'default', store))).toEqual(host);
  });

  it("a named login drops the host's auth keys and keeps the rest", async () => {
    expect(applyAccountEnv(host, await accountEnvPolicy(claude(), 'work', store))).toEqual({
      CLAUDE_EFFORT: 'high',
    });
  });

  it('a setup-token account injects its own token, never the host one', async () => {
    const env = applyAccountEnv(host, await accountEnvPolicy(claude(), 'ci', store));
    expect(env).toEqual({
      CLAUDE_EFFORT: 'high',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-' + 'x'.repeat(20),
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });
});

describe('boxAccount', () => {
  it('reads the record, default when absent', () => {
    expect(boxAccount(undefined, 'claude')).toBe('default');
    expect(boxAccount({ accounts: { claude: 'work' } }, 'claude')).toBe('work');
    expect(boxAccount({ accounts: { claude: 'work' } }, 'codex')).toBe('default');
  });
});

describe('boxesOnAccount (#442 review: accounts rm refuses while in use)', () => {
  const boxes = [
    { name: 'runs-work', accounts: { claude: 'work' } },
    { name: 'borrows-work', agents: ['pi'], accounts: { claude: 'work' } },
    { name: 'other', accounts: { claude: 'ci' } },
    { name: 'default-box' },
  ];
  it('finds every box that records the account, running or borrowing it', () => {
    expect(boxesOnAccount(boxes, 'claude', 'work').map((b) => b.name)).toEqual([
      'runs-work',
      'borrows-work',
    ]);
  });
  it('none for an unused account, another agent, or the default', () => {
    expect(boxesOnAccount(boxes, 'claude', 'nope')).toEqual([]);
    expect(boxesOnAccount(boxes, 'codex', 'work')).toEqual([]);
    expect(boxesOnAccount(boxes, 'claude', 'default')).toEqual([]);
  });
});
