import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startServer } from '../src/socket.js';
import { Supervisor } from '../src/supervisor.js';
import { reload } from '../src/client.js';
import { fetchWatchListWithRetry } from '../src/agent-registry.js';
import type { CtlConfig } from '../src/config.js';

/**
 * `agentbox openclaw <running box>`: the agent is added on the host, then the
 * live daemon must re-ask `agents.list`. A plain reload re-folds what it already
 * had, so the gateway never started (sign-off of #429, B1).
 */
describe('reload --agents', () => {
  let dir: string;
  let sock: string;
  let server: Server;
  let sup: Supervisor;
  let refreshed = 0;
  let refreshFails = false;
  const empty: CtlConfig = { tasks: [], services: [], replacements: {}, warnings: [] };

  beforeEach(async () => {
    refreshed = 0;
    refreshFails = false;
    dir = await mkdtemp(join(tmpdir(), 'ctl-reload-agents-'));
    sock = join(dir, 'ctl.sock');
    sup = new Supervisor({ workspace: dir, logDir: dir });
    await sup.init(empty);
    server = await startServer({
      socketPath: sock,
      supervisor: sup,
      logDir: dir,
      configPath: join(dir, 'nope.yaml'),
      reloadConfig: () => Promise.resolve(empty),
      refreshAgents: () => {
        if (refreshFails) return Promise.reject(new Error('agents.list unavailable'));
        refreshed++;
        return Promise.resolve();
      },
    });
  });
  afterEach(async () => {
    server.close();
    await sup.stopAll();
    await rm(dir, { recursive: true, force: true });
  });

  it('re-asks the host before folding the config', async () => {
    await reload({ socketPath: sock }, { refreshAgents: true });
    expect(refreshed).toBe(1);
  });

  it('a plain reload does not go back to the host', async () => {
    await reload({ socketPath: sock });
    expect(refreshed).toBe(0);
  });

  it('refuses, with the reason, when the host does not answer', async () => {
    refreshFails = true;
    await expect(reload({ socketPath: sock }, { refreshAgents: true })).rejects.toThrow(
      /agents\.list unavailable/,
    );
  });
});

/**
 * A hub-built cloud box launches ctl before the hub registers it, so the first
 * `agents.list` answers "unknown box" (sign-off of #429, B2). ctl retries.
 */
describe('fetchWatchListWithRetry', () => {
  const host = { files: [], sessions: [], units: [], renders: [], source: 'host' as const };
  const baked = { ...host, source: 'baked' as const };

  it('retries until the host answers', async () => {
    const answers = [baked, baked, host];
    const slept: number[] = [];
    const res = await fetchWatchListWithRetry({
      fetch: () => Promise.resolve(answers.shift() ?? host),
      delaysMs: [1, 2, 3, 4],
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });
    expect(res.source).toBe('host');
    expect(slept).toEqual([1, 2]);
  });

  it('gives up after the last delay with the last answer', async () => {
    let calls = 0;
    const res = await fetchWatchListWithRetry({
      fetch: () => {
        calls++;
        return Promise.resolve(baked);
      },
      delaysMs: [1, 1],
      sleep: () => Promise.resolve(),
    });
    expect(res.source).toBe('baked');
    expect(calls).toBe(3);
  });

  it('stops early when the daemon is shutting down', async () => {
    let calls = 0;
    await fetchWatchListWithRetry({
      fetch: () => {
        calls++;
        return Promise.resolve(baked);
      },
      delaysMs: [1, 1, 1],
      sleep: () => Promise.resolve(),
      stopped: () => true,
    });
    expect(calls).toBe(1);
  });
});
