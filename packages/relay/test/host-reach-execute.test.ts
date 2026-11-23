import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeHostReachAction } from '../src/daemon.js';
import { executeCloudAction } from '../src/host-actions.js';
import { PendingPrompts, PromptSubscribers } from '../src/prompts.js';
import type { HostAction } from '../src/types.js';
import { outboxItemForMe } from '../src/cp-outbox-drain.js';

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

  async function writeState(boxes: unknown[]): Promise<void> {
    await writeFile(
      join(homedir(), '.agentbox', 'state.json'),
      JSON.stringify({ version: 1, boxes }),
    );
  }
  const record = (workspacePath: string) => ({
    id: 'box-1',
    name: 'b1',
    provider: 'hetzner',
    workspacePath,
    createdAt: new Date().toISOString(),
    cloud: { backend: 'hetzner', sandboxId: '42' },
  });

  it('serves from its own record of the box over the folder the hub named (1)', async () => {
    const mine = join(dir, 'app-feature');
    const other = join(dir, 'app');
    await mkdir(mine, { recursive: true });
    await mkdir(other, { recursive: true });
    await writeState([record(mine)]);
    const seen: string[] = [];
    // A has-repo route naming the OTHER checkout: the record's folder wins, so
    // the containment check runs against it and passes for a repo path.
    const r = await executeHostReachAction(
      action({
        method: 'cp.toHost',
        params: { sources: ['/workspace/dist'], dest: '../escape' },
        route: { repoKey: 'github.com/acme/app', folder: other, role: 'has-repo' },
      }),
      deps({
        repoKeyOf: (f) => {
          seen.push(f);
          return Promise.resolve('github.com/acme/app');
        },
      }),
    );
    expect(seen[0]).toBe(mine);
    expect(r).toEqual({ decline: '../escape is outside its checkout of the repo' });
  });

  it('a has-repo PC declines ~ and other paths outside its checkout instead of prompting (2)', async () => {
    const r = await executeHostReachAction(
      action({
        params: { sources: ['~/.ssh/id_rsa'], dest: '/workspace' },
        route: {
          repoKey: 'github.com/acme/app',
          folder: dir,
          role: 'has-repo',
          box: { name: 'b1', backend: 'hetzner' },
        },
      }),
      deps({ repoKeyOf: () => Promise.resolve('github.com/acme/app') }),
    );
    expect(r).toEqual({ decline: '~/.ssh/id_rsa is outside its checkout of the repo' });
  });

  it('adopts a box it has no record of only after the copy is approved (4)', async () => {
    const prevEntry = process.env.AGENTBOX_CLI_ENTRY;
    process.env.AGENTBOX_CLI_ENTRY = join(dir, 'never-run.mjs');
    try {
      await writeFile(join(dir, 'data.csv'), 'x');
      const adopted: string[] = [];
      const run = (answer: 'y' | 'n') => {
        const d = deps({
          repoKeyOf: () => Promise.resolve('github.com/acme/app'),
          adopt: (boxId) => {
            adopted.push(boxId);
            return Promise.resolve({ ok: false, error: 'stubbed' });
          },
        });
        const p = executeHostReachAction(
          action({
            route: {
              repoKey: 'github.com/acme/app',
              folder: dir,
              role: 'has-repo',
              box: { name: 'b1', backend: 'hetzner' },
            },
          }),
          d,
        );
        // No record means no remembered consent: it asks, even for a contained copy.
        const answerSoon = async () => {
          for (let i = 0; i < 50 && d.prompts.size() === 0; i++)
            await new Promise((r) => setTimeout(r, 10));
          const [pending] = d.prompts.all();
          d.prompts.resolve(pending!.id, answer);
        };
        return Promise.all([p, answerSoon()]).then(([r]) => r);
      };
      expect(await run('n')).toMatchObject({ exitCode: 10 });
      expect(adopted).toEqual([]);
      expect(await run('y')).toMatchObject({
        exitCode: 69,
        stderr: 'could not adopt box box-1 here: stubbed\n',
      });
      expect(adopted).toEqual(['box-1']);
    } finally {
      if (prevEntry === undefined) delete process.env.AGENTBOX_CLI_ENTRY;
      else process.env.AGENTBOX_CLI_ENTRY = prevEntry;
    }
  });

  it('lands a parked copy only on the machine it is for (4)', () => {
    const meta = {
      id: 'o1',
      boxId: 'b',
      boxName: 'b',
      dest: '.',
      sources: [],
      createdAt: '',
      size: 0,
    };
    expect(outboxItemForMe({ ...meta, forMachineId: 'pc-a' }, 'pc-a')).toBe(true);
    expect(outboxItemForMe({ ...meta, forMachineId: 'pc-a' }, 'pc-b')).toBe(false);
    // Parked before items named their machine: any machine that knows the box.
    expect(outboxItemForMe(meta, 'pc-b')).toBe(true);
  });

  it('copies absolute host paths for a record with no project folder; only relative ones need it (6)', async () => {
    const stub = join(dir, 'stub-cli.mjs');
    await writeFile(stub, "process.stdout.write('ran ' + process.argv.slice(2).join(' '));\n");
    await writeState([record('')]);
    const prevEntry = process.env.AGENTBOX_CLI_ENTRY;
    process.env.AGENTBOX_CLI_ENTRY = stub;
    try {
      const abs = await executeCloudAction(
        action({ params: { sources: [join(dir, 'data.csv')], dest: '/workspace' } }),
        { backendName: 'hetzner', boxId: 'box-1', log: () => {} },
      );
      expect(abs.exitCode).toBe(0);
      expect(abs.stdout).toMatch(/^ran cp /);
      const rel = await executeCloudAction(action(), {
        backendName: 'hetzner',
        boxId: 'box-1',
        log: () => {},
      });
      expect(rel).toMatchObject({
        exitCode: 69,
        stderr: expect.stringMatching(/project folder .* does not exist here/),
      });
    } finally {
      if (prevEntry === undefined) delete process.env.AGENTBOX_CLI_ENTRY;
      else process.env.AGENTBOX_CLI_ENTRY = prevEntry;
    }
  });

  it('serves its OWN box under the normal rules when it is the origin and has no record yet (sign-off re-check)', async () => {
    const stub = join(dir, 'stub-cli.mjs');
    await writeFile(stub, "process.stdout.write('copied');\n");
    await writeFile(join(dir, 'data.csv'), 'x');
    const prevEntry = process.env.AGENTBOX_CLI_ENTRY;
    process.env.AGENTBOX_CLI_ENTRY = stub;
    try {
      const adopted: string[] = [];
      const d = deps({
        machineId: () => 'pc-a',
        repoKeyOf: () => Promise.resolve('github.com/acme/app'),
        adopt: (boxId) => {
          adopted.push(boxId);
          return Promise.resolve({ ok: true });
        },
      });
      const r = await executeHostReachAction(
        action({
          route: {
            repoKey: 'github.com/acme/app',
            folder: dir,
            role: 'origin',
            box: { name: 'b1', backend: 'hetzner', originMachineId: 'pc-a' },
          },
        }),
        d,
      );
      // A contained, non-secret copy auto-approves as it would with a record:
      // no confirm (an unattended copy is not denied by a timeout), then adopt.
      expect(d.prompts.size()).toBe(0);
      expect(adopted).toEqual(['box-1']);
      expect(r).toMatchObject({ exitCode: 0, stdout: 'copied' });
    } finally {
      if (prevEntry === undefined) delete process.env.AGENTBOX_CLI_ENTRY;
      else process.env.AGENTBOX_CLI_ENTRY = prevEntry;
    }
  });

  it('still always asks when the route says origin but this PC is not that machine', async () => {
    const prevEntry = process.env.AGENTBOX_CLI_ENTRY;
    process.env.AGENTBOX_CLI_ENTRY = join(dir, 'never-run.mjs');
    try {
      await writeFile(join(dir, 'data.csv'), 'x');
      const d = deps({
        machineId: () => 'pc-b',
        repoKeyOf: () => Promise.resolve('github.com/acme/app'),
        adopt: () => Promise.resolve({ ok: true }),
      });
      const p = executeHostReachAction(
        action({
          route: {
            repoKey: 'github.com/acme/app',
            folder: dir,
            role: 'origin',
            box: { name: 'b1', backend: 'hetzner', originMachineId: 'pc-a' },
          },
        }),
        d,
      );
      for (let i = 0; i < 50 && d.prompts.size() === 0; i++)
        await new Promise((r) => setTimeout(r, 10));
      expect(d.prompts.size()).toBe(1);
      d.prompts.resolve(d.prompts.all()[0]!.id, 'n');
      expect(await p).toMatchObject({ exitCode: 10 });
    } finally {
      if (prevEntry === undefined) delete process.env.AGENTBOX_CLI_ENTRY;
      else process.env.AGENTBOX_CLI_ENTRY = prevEntry;
    }
  });

  it('an origin PC with no record adopts the box once a download is approved (follow-up 2)', async () => {
    const adopted: string[] = [];
    const d = deps({
      machineId: () => 'pc-a',
      repoKeyOf: () => Promise.resolve('github.com/acme/app'),
      adopt: (boxId) => {
        adopted.push(boxId);
        return Promise.resolve({ ok: false, error: 'stubbed' });
      },
    });
    const p = executeHostReachAction(
      action({
        method: 'download.workspace',
        params: { kind: 'workspace' },
        route: {
          repoKey: 'github.com/acme/app',
          folder: dir,
          role: 'origin',
          box: { name: 'b1', backend: 'hetzner', originMachineId: 'pc-a' },
        },
      }),
      d,
    );
    // A download overwrites the project, so it ALWAYS asks — even contained in
    // the project folder, even under autoApproveSafeHostActions.
    for (let i = 0; i < 50 && d.prompts.size() === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(d.prompts.size()).toBe(1);
    // The prompt says it overwrites, where, and that .git is left alone.
    const detail = String((d.prompts.all()[0]!.ev as { detail?: string }).detail);
    expect(detail).toContain('OVERWRITES');
    expect(detail).toContain(dir);
    expect(detail).toContain('.git is never touched');
    expect(adopted).toEqual([]);
    d.prompts.resolve(d.prompts.all()[0]!.id, 'y');
    const r = await p;
    expect(adopted).toEqual(['box-1']);
    expect(r).toMatchObject({ exitCode: 69, stderr: 'could not adopt box box-1 here: stubbed\n' });
  });

  it('a download with no one to ask is refused, not run', async () => {
    await writeState([record(dir)]);
    const out = await executeCloudAction(
      action({ method: 'download.workspace', params: { kind: 'workspace' } }),
      { backendName: 'hetzner', boxId: 'box-1', log: () => {} },
    );
    expect(out).toMatchObject({ exitCode: 10 });
  });

  it('a plain download (not host-reach) does not refuse a moved project folder', async () => {
    await writeState([record(join(dir, 'moved-away'))]);
    const out = await executeCloudAction(
      action({ method: 'download.workspace', params: { kind: 'workspace' } }),
      { backendName: 'hetzner', boxId: 'box-1', log: () => {} },
    ).catch((e: unknown) => ({ exitCode: -1, stdout: '', stderr: String(e) }));
    // Whatever happens next (no provider here), it is not the host-reach guard.
    expect(out.stderr).not.toMatch(/project folder .* does not exist here/);
  });
});
