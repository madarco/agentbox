/**
 * Who a push belongs to, when the branch bypasses the confirm gate.
 *
 * `agentbox git push <box>` mints a one-time token, and consuming it is the
 * ONLY way the relay learns the host drove the push. Before, the consume sat
 * behind `!bypassPushGate`, so on an `agentbox/*` scratch branch — the common
 * case — the token was never read: the relay logged the push as the box's while
 * the hub's git route logged the same push as the human's, and the timeline
 * showed it twice.
 */
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decideHostInitiatedPush, hashRpcParams } from '../src/host-initiated.js';
import { startRelayServer, type RelayServerHandle } from '../src/server.js';
import { configureTimelineSink } from '../src/workspaces/timeline-sink.js';
import type { TimelineEventInput } from '../src/workspaces/timeline-store.js';

describe('decideHostInitiatedPush', () => {
  const decide = (bypassPushGate: boolean, tokenClaimed: boolean, valid: boolean) =>
    decideHostInitiatedPush({ bypassPushGate, tokenClaimed, consume: () => valid });

  it('honours a valid token whether or not the branch bypasses the gate', () => {
    expect(decide(false, true, true)).toEqual({ hostInitiated: true, reject: false });
    expect(decide(true, true, true)).toEqual({ hostInitiated: true, reject: false });
  });

  it('hard-rejects an invalid token only where the token is what unlocks the push', () => {
    expect(decide(false, true, false)).toEqual({ hostInitiated: false, reject: true });
    // A scratch push never needed a token, so a bad one must not start failing it.
    expect(decide(true, true, false)).toEqual({ hostInitiated: false, reject: false });
  });

  it('leaves a push with no token claimed to the prompt', () => {
    expect(decide(false, false, false)).toEqual({ hostInitiated: false, reject: false });
    expect(decide(true, false, false)).toEqual({ hostInitiated: false, reject: false });
  });
});

async function git(repo: string, ...args: string[]): Promise<string> {
  const r = await execa('git', [
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    '-c',
    'commit.gpgsign=false',
    '-C',
    repo,
    ...args,
  ]);
  return r.stdout.trim();
}

/** A host repo on `agentbox/box-one` with a real `origin` to push to. */
async function repoWithOrigin(): Promise<{ dir: string; commit: () => Promise<void> }> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'agentbox-hostinit-')));
  const origin = join(base, 'origin.git');
  const dir = join(base, 'work');
  await execa('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  await execa('git', ['init', '-q', '-b', 'main', dir]);
  await git(dir, 'remote', 'add', 'origin', origin);
  let n = 0;
  const commit = async (): Promise<void> => {
    n += 1;
    await writeFile(join(dir, `f${String(n)}.txt`), `line ${String(n)}\n`);
    await git(dir, 'add', '-A');
    await git(dir, 'commit', '-q', '-m', `c${String(n)}`);
  };
  await commit();
  await git(dir, 'checkout', '-q', '-b', 'agentbox/box-one');
  return { dir, commit };
}

describe('a push on a scratch branch', () => {
  let handle: RelayServerHandle;
  let rows: TimelineEventInput[];

  beforeEach(async () => {
    rows = [];
    configureTimelineSink({
      kind: 'remote',
      record: async (_wsId, input) => {
        rows.push(input);
        return null;
      },
      workspaceFor: async () => ({ id: 'ws1' }),
    });
    handle = await startRelayServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    await handle.close();
    configureTimelineSink(null);
  });

  function url(path: string): string {
    return `http://127.0.0.1:${String((handle.server.address() as AddressInfo).port)}${path}`;
  }

  async function post(path: string, body: unknown, token?: string): Promise<Response> {
    return fetch(url(path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  /** Run the push RPC; it must succeed, or the row under test is never reached. */
  async function push(hostInitiated?: string): Promise<void> {
    const params = { path: '/workspace', ...(hostInitiated ? { hostInitiated } : {}) };
    const res = await post('/rpc', { method: 'git.push', params }, 'tok');
    const body = (await res.json()) as { exitCode: number; stderr: string };
    expect(body.stderr).not.toMatch(/token rejected/);
    expect(body.exitCode).toBe(0);
  }

  /**
   * The row is recorded after the RPC answers, so it is waited FOR rather than
   * slept for — a fixed sleep is what makes a suite like this flaky on a loaded
   * machine.
   */
  async function settledRows(want: number): Promise<TimelineEventInput[]> {
    for (let i = 0; i < 200 && rows.length < want; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    // A row that should NOT be there would be written by the same code on the
    // same clock; give it the grace the awaited one just took.
    await new Promise((r) => setTimeout(r, 250));
    return rows;
  }

  async function registerBox(repo: string): Promise<void> {
    const res = await post('/admin/register-box', {
      boxId: 'b1',
      token: 'tok',
      name: 'box-one',
      worktrees: [{ containerPath: '/workspace', hostMainRepo: repo, branch: 'agentbox/box-one' }],
    });
    expect(res.status).toBe(204);
  }

  async function mint(params: unknown): Promise<string> {
    const res = await post('/admin/host-initiated/mint', {
      boxId: 'b1',
      method: 'git.push',
      paramsHash: hashRpcParams(params),
    });
    return ((await res.json()) as { token: string }).token;
  }

  it('belongs to the HOST when it carries a valid token, so only the hub logs it', async () => {
    const { dir, commit } = await repoWithOrigin();
    await registerBox(dir);
    await push(await mint({ path: '/workspace' }));
    // A second push with NO token is the marker: once ITS row has landed, a row
    // for the first would have landed too — and there is exactly one.
    await commit();
    await push();
    expect(await settledRows(1)).toHaveLength(1);
  });

  it('belongs to the BOX with no token, and logs one row', async () => {
    const { dir } = await repoWithOrigin();
    await registerBox(dir);
    await push();
    const logged = await settledRows(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ type: 'git.push', actor: 'box', boxId: 'b1' });
  });

  it('still pushes with a token that does not validate, and logs as before', async () => {
    // The hard rejection is gate-only: a scratch push never needed a token.
    const { dir } = await repoWithOrigin();
    await registerBox(dir);
    await push('not-a-real-token');
    const logged = await settledRows(1);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ type: 'git.push', actor: 'box' });
  });
});
