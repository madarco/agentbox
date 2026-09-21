import { join } from 'node:path';
import { boxSh, createBox, waitBoxState } from '../lib/box.js';
import { ab } from '../lib/exec.js';
import { cloneTestRepo } from '../lib/github.js';
import { hubBox } from '../lib/hub.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';
import { findLeaks } from '../lib/sweep.js';

interface S3Vars {
  repo: string;
  token: string;
  checkpoint: string;
}
const v = (ctx: Ctx) => ctx.vars as unknown as S3Vars;

async function markerIn(ctx: Ctx, box: string): Promise<void> {
  const r = await boxSh(ctx, box, 'cat e2e-marker.txt', { allowFail: true });
  if (r.stdout.trim() !== v(ctx).token)
    throw new Error(
      `${box}: /workspace/e2e-marker.txt is "${r.stdout.trim()}", want "${v(ctx).token}"`,
    );
}

/** Paused / stopped may read differently per provider (a cloud pause is an archive). */
const PAUSED = ['paused', 'stopped', 'archived'];

export const s3: ScenarioDef = {
  id: 's3',
  title: 'Lifecycle and checkpoints',
  covers: [
    'PAUSE-001',
    'PAUSE-002',
    'PAUSE-003',
    'START-001',
    'START-002',
    'CKPT-001',
    'CKPT-002',
    'CKPT-003',
    'CKPT-006',
    'CKPT-007',
    'CREATE-004',
    'DESTROY-001',
  ],
  boxes: 2,
  steps: [
    {
      name: 'create a box and write a marker into /workspace',
      covers: ['CREATE-001'],
      fn: async (ctx) => {
        const repo = join(ctx.dir, 'repo');
        await cloneTestRepo(repo, ctx.log);
        const token = `marker-${ctx.opts.runId}-${ctx.target.slug}`;
        Object.assign(ctx.vars, { repo, token, checkpoint: `${ctx.box()}-ck` } satisfies S3Vars);
        await createBox(ctx, ctx.box(), repo);
        await boxSh(ctx, ctx.box(), `printf '%s' '${token}' > e2e-marker.txt`);
        await markerIn(ctx, ctx.box());
      },
    },
    {
      name: 'pause and unpause keep the workspace',
      covers: ['PAUSE-001', 'PAUSE-002', 'PAUSE-003'],
      fn: async (ctx) => {
        await ab(['pause', ctx.box()], { cwd: v(ctx).repo, log: ctx.log, timeoutMs: 20 * 60_000 });
        const paused = await waitBoxState(ctx, ctx.box(), PAUSED, 15 * 60_000);
        ctx.note(`paused state: ${String(paused.state ?? paused.status)}`);
        await ab(['unpause', ctx.box()], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 20 * 60_000,
        });
        await waitBoxState(ctx, ctx.box(), ['running'], 15 * 60_000);
        await markerIn(ctx, ctx.box());
      },
    },
    {
      name: 'stop and start keep the workspace',
      covers: ['START-001'],
      fn: async (ctx) => {
        await ab(['stop', ctx.box()], { cwd: v(ctx).repo, log: ctx.log, timeoutMs: 20 * 60_000 });
        // A cloud provider may implement stop as its pause (E2B does); either keeps the disk.
        const stopped = await waitBoxState(ctx, ctx.box(), ['stopped', 'paused'], 15 * 60_000);
        ctx.note(`stopped state: ${String(stopped.state ?? stopped.status)}`);
        await ab(['start', ctx.box()], { cwd: v(ctx).repo, log: ctx.log, timeoutMs: 20 * 60_000 });
        await waitBoxState(ctx, ctx.box(), ['running'], 15 * 60_000);
        await markerIn(ctx, ctx.box());
      },
    },
    {
      name: '`start` on a running box is a no-op',
      covers: ['START-002'],
      fn: async (ctx) => {
        const r = await ab(['start', ctx.box()], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 5 * 60_000,
        });
        const b = await hubBox(ctx.box());
        if ((b?.state ?? b?.status) !== 'running')
          throw new Error(`state is ${String(b?.state ?? b?.status)} after start on a running box`);
        ctx.note(`${String(Math.round(r.durationMs / 1000))}s`);
      },
    },
    {
      name: 'checkpoint the box',
      covers: ['CKPT-001', 'CKPT-002'],
      fn: async (ctx) => {
        await ab(['checkpoint', 'create', ctx.box(), '--name', v(ctx).checkpoint, '-y'], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 45 * 60_000,
        });
        const ls = await ab(['checkpoint', 'ls'], { cwd: v(ctx).repo, log: ctx.log });
        if (!ls.stdout.includes(v(ctx).checkpoint))
          throw new Error(`checkpoint ls doesn't list ${v(ctx).checkpoint}:\n${ls.stdout}`);
      },
    },
    {
      name: 'a new box started from the checkpoint has the marker',
      covers: ['CREATE-004'],
      fn: async (ctx) => {
        await createBox(ctx, ctx.box('b'), v(ctx).repo, ['--snapshot', v(ctx).checkpoint]);
        await markerIn(ctx, ctx.box('b'));
      },
    },
    {
      name: 'set-default pins and clears the project default',
      covers: ['CKPT-003', 'CKPT-005'],
      fn: async (ctx) => {
        await ab(['checkpoint', 'set-default', v(ctx).checkpoint], {
          cwd: v(ctx).repo,
          log: ctx.log,
        });
        const on = await ab(['config', 'get', 'box.defaultCheckpoint'], {
          cwd: v(ctx).repo,
          log: ctx.log,
          allowFail: true,
        });
        await ab(['checkpoint', 'set-default', '--clear'], { cwd: v(ctx).repo, log: ctx.log });
        const off = await ab(['config', 'get', 'box.defaultCheckpoint'], {
          cwd: v(ctx).repo,
          log: ctx.log,
          allowFail: true,
        });
        if (!on.stdout.includes(v(ctx).checkpoint))
          throw new Error(`after set-default, box.defaultCheckpoint = "${on.stdout.trim()}"`);
        if (off.stdout.includes(v(ctx).checkpoint))
          throw new Error(`after --clear, box.defaultCheckpoint = "${off.stdout.trim()}"`);
      },
    },
    {
      name: 'destroy both boxes and the checkpoint, leaving nothing behind',
      covers: ['DESTROY-001', 'CKPT-006'],
      fn: async (ctx) => {
        for (const b of [ctx.box('b'), ctx.box()]) {
          await ab(['destroy', '-y', b], {
            cwd: v(ctx).repo,
            log: ctx.log,
            timeoutMs: 20 * 60_000,
          });
          if (await hubBox(b)) throw new Error(`${b} still listed after destroy`);
        }
        await ab(['checkpoint', 'rm', v(ctx).checkpoint, '-y'], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 10 * 60_000,
        });
        const ls = await ab(['checkpoint', 'ls'], { cwd: v(ctx).repo, log: ctx.log });
        if (ls.stdout.includes(v(ctx).checkpoint))
          throw new Error(`${v(ctx).checkpoint} still listed after rm`);
        const leaks = (await findLeaks(ctx.target, ctx.opts.runId, ctx.log)).filter((l) =>
          l.name.includes(`-${ctx.scenario}`),
        );
        if (leaks.length)
          throw new Error(`left behind: ${leaks.map((l) => `${l.kind} ${l.name}`).join(', ')}`);
      },
    },
  ],
  // A failed run must not leave a cloud snapshot or a project default behind.
  teardown: async (ctx) => {
    if (!v(ctx).checkpoint) return;
    await ab(['checkpoint', 'set-default', '--clear'], {
      cwd: v(ctx).repo,
      log: ctx.log,
      allowFail: true,
    });
    await ab(['checkpoint', 'rm', v(ctx).checkpoint, '-y'], {
      cwd: v(ctx).repo,
      log: ctx.log,
      allowFail: true,
      timeoutMs: 600_000,
    });
  },
};
