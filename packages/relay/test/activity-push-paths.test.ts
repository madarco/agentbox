import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudBackend } from '@agentbox/core';
import {
  configureActivityLedger,
  SqliteActivityStore,
  type ActivityStore,
} from '../src/activity/index.js';
import { executeCloudAction, setCloudBackendLoader } from '../src/host-actions.js';
import { hashRpcParams, HostInitiatedTokens } from '../src/host-initiated.js';
import { configureBoxPushStat, parsePushedTips } from '../src/workspaces/push-stat.js';
import type { HostAction } from '../src/types.js';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import type { AddressInfo } from 'node:net';

/**
 * The ledger's push rows once every branch in `branches` has one. A row is
 * written after the push answers, and a slow runner (git, the box context's
 * `git remote` probe) can take well over a second, so this polls instead of
 * sleeping a fixed time.
 */
async function pushRowsFor(store: ActivityStore, branches: string[]) {
  return vi.waitFor(
    async () => {
      const rows = await store.list({ types: ['git.push'] });
      const have = new Set(rows.map((r) => r.branch));
      for (const b of branches) if (!have.has(b)) throw new Error(`no row for ${b} yet`);
      return rows;
    },
    { timeout: 20_000, interval: 25 },
  );
}

/**
 * One ledger row per push, whichever path ran it: a cloud box's own push out of
 * a control box's scratch repo is measured from the remote's old tip, and a
 * host-only landing is recorded by the relay unless the hub's route drove it.
 */
describe('parsePushedTips', () => {
  it('reads a fast-forward, a forced update and a new branch, by destination', () => {
    const out = [
      'To github.com:acme/x.git',
      '   a1b2c3d..e4f5a6b  agentbox/one -> agentbox/one',
      ' + 1111111...2222222 other -> other (forced update)',
      ' * [new branch]      feat -> landed',
    ].join('\n');
    expect(parsePushedTips(out, 'agentbox/one')).toEqual({ before: 'a1b2c3d', after: 'e4f5a6b' });
    expect(parsePushedTips(out, 'other')).toEqual({ before: '1111111', after: '2222222' });
    expect(parsePushedTips(out, 'landed')).toEqual({ created: true });
    expect(parsePushedTips('Everything up-to-date\n', 'agentbox/one')).toBeUndefined();
  });
});

describe('a cloud box push, recorded once', () => {
  const BRANCH = 'feature/x';
  let store: ActivityStore;
  let src: string;
  let bare: string;
  let host: string;
  let oldTip: string;
  let statAsked: { before?: string }[];

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync('git', ['-C', cwd, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();

  async function commit(file: string): Promise<string> {
    await writeFile(join(src, file), `${file}\n`);
    git(src, 'add', file);
    git(src, 'commit', '-q', '-m', file);
    return git(src, 'rev-parse', 'HEAD');
  }

  async function writeState(workspacePath: string): Promise<void> {
    const dir = join(homedir(), '.agentbox');
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        boxes: [
          {
            id: 'box1',
            name: 'box-one',
            provider: 'daytona',
            workspacePath,
            cloud: { sandboxId: 'sb1', workspaceBranch: BRANCH, sanctionedBranch: BRANCH },
          },
        ],
      }),
    );
  }

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'ledger-push-'));
    src = join(root, 'src');
    bare = join(root, 'origin.git');
    host = join(root, 'host');
    await mkdir(src);
    git(src, 'init', '-q', '-b', 'main');
    await commit('base');
    git(src, 'checkout', '-q', '-b', BRANCH);
    oldTip = await commit('one');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    git(src, 'push', '-q', bare, `main`, BRANCH);
    execFileSync('git', ['clone', '-q', bare, host]);
    await commit('two');

    store = new SqliteActivityStore(':memory:');
    await store.migrate();
    configureActivityLedger(store);
    statAsked = [];
    configureBoxPushStat(async (_id, opts) => {
      statAsked.push(opts?.before ? { before: opts.before } : {});
      return { additions: 1, deletions: 0, commits: 1, filesChanged: 1 };
    });
    const backend = {
      name: 'fake',
      async exec(_h: unknown, cmd: string) {
        if (cmd.includes('rev-parse --abbrev-ref HEAD')) {
          return { exitCode: 0, stdout: `${BRANCH}\n`, stderr: '' };
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      async downloadFile(_h: unknown, _remote: string, local: string) {
        git(src, 'bundle', 'create', local, BRANCH);
      },
    } as unknown as CloudBackend;
    setCloudBackendLoader({
      id: 'test',
      resolveBackend: async () => backend,
      loadCloudCp: () => Promise.reject(new Error('not used')),
    });
  });

  afterEach(() => {
    setCloudBackendLoader(undefined);
    configureActivityLedger(null);
    configureBoxPushStat(null);
  });

  function run(
    params: Record<string, unknown>,
    tokens?: HostInitiatedTokens,
  ): Promise<{ exitCode: number; stderr: string }> {
    const action: HostAction = {
      id: 'a1',
      boxId: 'box1',
      method: 'git.push',
      params: { path: '/workspace', ...params },
      createdAt: new Date().toISOString(),
    };
    return executeCloudAction(action, {
      backendName: 'fake',
      boxId: 'box1',
      boxName: 'box-one',
      originUrl: bare,
      log: () => {},
      ...(tokens ? { hostInitiatedTokens: tokens } : {}),
    }) as Promise<{ exitCode: number; stderr: string }>;
  }

  it("measures a control box's push from the remote's old tip, not the whole branch", async () => {
    await writeState(''); // no host checkout: a scratch repo against the origin
    const r = await run({});
    expect(r.exitCode, r.stderr).toBe(0);
    const pushed = await pushRowsFor(store, [BRANCH]);
    expect(pushed).toHaveLength(1);
    expect(statAsked).toEqual([{ before: oldTip.slice(0, 7) }]);
    expect(pushed[0]).toMatchObject({ actor: 'box', commits: 1 });
  });

  it('records a box-initiated host-only landing once, and none the hub route drove', async () => {
    await writeState(host);
    const r = await run({ hostOnly: true, as: 'landed' });
    expect(r.exitCode, r.stderr).toBe(0);
    const landed = await pushRowsFor(store, ['landed']);
    expect(landed).toHaveLength(1);
    expect(landed[0]).toMatchObject({ hostOnly: true, branch: 'landed', commits: 2 });

    const tokens = new HostInitiatedTokens();
    const params = { path: '/workspace', hostOnly: true, as: 'landed2' };
    const token = tokens.mint('box1', 'git.push', hashRpcParams(params));
    const r2 = await run({ ...params, hostInitiated: token }, tokens);
    expect(r2.exitCode, r2.stderr).toBe(0);
    // A later box landing is the sentinel: once its row is in, the hub's
    // landing (which is never written) has had every chance to be.
    expect((await run({ hostOnly: true, as: 'landed3' })).exitCode).toBe(0);
    const all = await pushRowsFor(store, ['landed', 'landed3']);
    expect(all.map((r) => r.branch).sort()).toEqual(['landed', 'landed3']);
  });
});

describe('a docker box host-only landing, recorded once', () => {
  let handle: RelayServerHandle;
  let store: ActivityStore;
  let repo: string;

  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    }).trim();

  async function post(path: string, body: unknown, token?: string): Promise<Response> {
    const port = (handle.server.address() as AddressInfo).port;
    return fetch(`http://127.0.0.1:${String(port)}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'ledger-docker-'));
    git('init', '-q', '-b', 'main');
    for (const f of ['base', 'one', 'two']) {
      if (f === 'one') git('checkout', '-q', '-b', 'agentbox/box-one');
      await writeFile(join(repo, f), `${f}\n`);
      git('add', f);
      git('commit', '-q', '-m', f);
    }
    store = new SqliteActivityStore(':memory:');
    await store.migrate();
    configureActivityLedger(store);
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
    const reg = await post('/admin/register-box', {
      boxId: 'b1',
      token: 't1',
      name: 'box-one',
      worktrees: [{ containerPath: '/workspace', hostMainRepo: repo, branch: 'agentbox/box-one' }],
    });
    expect(reg.status).toBe(204);
  });

  afterEach(async () => {
    await handle.close();
    configureActivityLedger(null);
  });

  it("records the box's own landing, and not the one the hub's route drove", async () => {
    const land = await post(
      '/rpc',
      { method: 'git.push', params: { path: '/workspace', hostOnly: true, as: 'landed' } },
      't1',
    );
    expect(land.status, await land.clone().text()).toBe(200);
    const rows = await pushRowsFor(store, ['landed']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hostOnly: true, branch: 'landed', commits: 2, actor: 'box' });

    const params = { path: '/workspace', hostOnly: true, as: 'landed2' };
    const minted = (await (
      await post('/admin/host-initiated/mint', {
        boxId: 'b1',
        method: 'git.push',
        paramsHash: hashRpcParams(params),
      })
    ).json()) as { token: string };
    const hubLand = await post(
      '/rpc',
      { method: 'git.push', params: { ...params, hostInitiated: minted.token } },
      't1',
    );
    expect(hubLand.status).toBe(200);
    // The sentinel, as in the cloud test: a later box landing.
    const box3 = await post(
      '/rpc',
      { method: 'git.push', params: { path: '/workspace', hostOnly: true, as: 'landed3' } },
      't1',
    );
    expect(box3.status).toBe(200);
    const all = await pushRowsFor(store, ['landed', 'landed3']);
    expect(all.map((r) => r.branch).sort()).toEqual(['landed', 'landed3']);
  });
});
