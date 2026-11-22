import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeHostReachAction } from '../src/daemon.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';
import type { HostAction } from '../src/types.js';

/**
 * The serving PC's decisions (multi-PC Phase 4): which folder it serves from,
 * when it adopts a hub box, and what it tells the hub when it cannot serve.
 * HOME is a per-file temp dir (test/setup.ts), so state.json here is scratch.
 */

const deps = (over: Partial<Parameters<typeof executeHostReachAction>[1]> = {}) => ({
  prompts: new PendingPrompts(),
  subscribers: new PromptSubscribers(),
  log: () => {},
  cache: { controlPlaneUrl: 'http://hub.invalid', adminToken: 't' },
  ...over,
});

function action(over: Partial<HostAction> = {}): HostAction {
  return {
    id: 'a1',
    boxId: 'box-1',
    method: 'cp.fromHost',
    params: { sources: ['data.csv'], dest: '/workspace' },
    createdAt: new Date().toISOString(),
    ...over,
  };
}

describe('executeHostReachAction', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reach-exec-'));
    await mkdir(join(homedir(), '.agentbox'), { recursive: true });
    await writeFile(
      join(homedir(), '.agentbox', 'state.json'),
      JSON.stringify({ version: 1, boxes: [] }),
    );
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('declines a routed action whose checkout folder is gone, saying so', async () => {
    const r = await executeHostReachAction(
      action({ route: { repoKey: 'github.com/acme/app', folder: join(dir, 'missing') } }),
      deps(),
    );
    expect(r).toEqual({ decline: expect.stringMatching(/checkout .*missing is gone/) });
  });

  it('adopts an unknown hub box in its own checkout before serving', async () => {
    const adopted: Array<[string, string]> = [];
    const r = await executeHostReachAction(
      action({ route: { repoKey: 'github.com/acme/app', folder: dir } }),
      deps({
        repoKeyOf: () => Promise.resolve('github.com/acme/app'),
        adopt: (boxId, cwd) => {
          adopted.push([boxId, cwd]);
          // A failed adoption: the action is handed on with the reason.
          return Promise.resolve({ ok: false, error: 'no such box on the hub' });
        },
      }),
    );
    expect(adopted).toEqual([['box-1', dir]]);
    expect(r).toEqual({ decline: 'could not adopt box box-1 here: no such box on the hub' });
  });

  it('refuses a folder the hub named that is not a checkout of the routed repo', async () => {
    // e.g. a registry row pointing at the home directory: it would make every
    // file under it "contained" and auto-approvable.
    const r = await executeHostReachAction(
      action({ route: { repoKey: 'github.com/acme/app', folder: dir } }),
      deps({ repoKeyOf: () => Promise.resolve(undefined) }),
    );
    expect(r).toEqual({
      decline: expect.stringMatching(/is not a checkout of github.com\/acme\/app/),
    });
  });

  it('declines a routed action for an unknown box with no checkout here', async () => {
    const r = await executeHostReachAction(
      action({ route: { repoKey: 'github.com/acme/app' } }),
      deps(),
    );
    expect(r).toEqual({ decline: expect.stringMatching(/no record of box box-1/) });
  });

  it('keeps the old answer for an unrouted action on an unknown box', async () => {
    expect(await executeHostReachAction(action(), deps())).toBe('not-mine');
  });
});
