import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boxSh, createBox } from '../lib/box.js';
import { REPO_ROOT } from '../lib/env.js';
import { ab, abJson, poll, run } from '../lib/exec.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';

const v = (ctx: Ctx) => ctx.vars as { app: string; url?: string };

async function webJson(url: string): Promise<{ greeting?: string; pid?: number }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${String(res.status)}`);
  return (await res.json()) as { greeting?: string; pid?: number };
}

export const s4: ScenarioDef = {
  id: 's4',
  title: 'A project with services',
  covers: [
    'WAIT-001',
    'WAIT-003',
    'STATUS-001',
    'LOGS-001',
    'URL-001',
    'URL-002',
    'SCREEN-001',
    'CP-001',
    'CP-002',
    'DL-001',
    'CTL-006',
    'CTL-010',
    'TOP-001',
  ],
  boxes: 1,
  steps: [
    {
      name: 'start examples/express-ready in a box',
      fn: async (ctx) => {
        // A copy with its own git repo: inside the monorepo, project discovery would
        // walk up to the repo's own agentbox.yaml.
        const app = join(ctx.dir, 'express-ready');
        cpSync(join(REPO_ROOT, 'examples', 'express-ready'), app, {
          recursive: true,
          filter: (src) => !src.includes('node_modules'),
        });
        await run('git', ['init', '-q'], { cwd: app, log: ctx.log });
        await run('git', ['add', '-A'], { cwd: app, log: ctx.log });
        await run('git', ['commit', '-qm', 'e2e: express-ready'], { cwd: app, log: ctx.log });
        Object.assign(ctx.vars, { app });
        await createBox(ctx, ctx.box(), app);
      },
    },
    {
      name: '`wait` returns once postgres and web are ready',
      covers: ['WAIT-001', 'CTL-006'],
      fn: async (ctx) => {
        await ab(['wait', ctx.box(), '--timeout', String(10 * 60_000), '-j'], {
          cwd: v(ctx).app,
          log: ctx.log,
          timeoutMs: 11 * 60_000,
        });
      },
    },
    {
      name: '`status` and `logs` show the services',
      covers: ['STATUS-001', 'LOGS-001'],
      fn: async (ctx) => {
        const st = await ab(['status', ctx.box()], { cwd: v(ctx).app, log: ctx.log });
        const missing = ['web', 'postgres', 'install'].filter((u) => !st.stdout.includes(u));
        if (missing.length) throw new Error(`status lacks ${missing.join(', ')}:\n${st.stdout}`);
        const logs = await ab(['logs', ctx.box(), 'web', '-n', '50'], {
          cwd: v(ctx).app,
          log: ctx.log,
        });
        if (!/Listening on/.test(logs.stdout))
          throw new Error(`web logs lack "Listening on":\n${logs.stdout}`);
      },
    },
    {
      name: 'the web URL answers from the host',
      covers: ['URL-001', 'URL-002'],
      fn: async (ctx) => {
        const args = [
          'url',
          ctx.box(),
          '--print',
          ...(ctx.target.kind === 'docker' ? ['--loopback'] : []),
        ];
        const url =
          (await ab(args, { cwd: v(ctx).app, log: ctx.log })).stdout.trim().split('\n').pop() ?? '';
        if (!/^https?:\/\//.test(url)) throw new Error(`url --print gave "${url}"`);
        v(ctx).url = url;
        const body = await poll('the web app to answer', () => webJson(url), {
          timeoutMs: 120_000,
          intervalMs: 5000,
        });
        if (!body.greeting) throw new Error(`GET ${url} returned ${JSON.stringify(body)}`);
        ctx.note(`${url} -> ${JSON.stringify(body)}`);
      },
    },
    {
      name: 'the VNC URL answers',
      covers: ['SCREEN-001'],
      fn: async (ctx) => {
        const args = [
          'screen',
          ctx.box(),
          '--print',
          ...(ctx.target.kind === 'docker' ? ['--loopback'] : []),
        ];
        const url =
          (await ab(args, { cwd: v(ctx).app, log: ctx.log })).stdout.trim().split('\n').pop() ?? '';
        const res = await poll(
          'the VNC page',
          async () => {
            const r = await fetch(url, { signal: AbortSignal.timeout(20_000) });
            return r.ok ? r : undefined;
          },
          { timeoutMs: 90_000, intervalMs: 5000 },
        );
        const html = await res.text();
        if (!/novnc|vnc/i.test(html)) throw new Error(`${url} is not a noVNC page`);
      },
    },
    {
      name: '`cp` copies a file in and back out',
      covers: ['CP-001', 'CP-002'],
      fn: async (ctx) => {
        const src = join(ctx.dir, 'cp-in.txt');
        const back = join(ctx.dir, 'cp-back.txt');
        const token = `cp-${ctx.opts.runId}`;
        writeFileSync(src, token);
        await ab(['cp', src, `${ctx.box()}:/workspace/cp-in.txt`], {
          cwd: v(ctx).app,
          log: ctx.log,
        });
        const inBox = await boxSh(ctx, ctx.box(), 'cat cp-in.txt');
        if (inBox.stdout.trim() !== token) throw new Error(`box has "${inBox.stdout.trim()}"`);
        await ab(['cp', `${ctx.box()}:/workspace/cp-in.txt`, back], {
          cwd: v(ctx).app,
          log: ctx.log,
        });
        if (readFileSync(back, 'utf8').trim() !== token) throw new Error('the copy back differs');
      },
    },
    {
      name: '`download` brings a box-made file to the host',
      covers: ['DL-001'],
      fn: async (ctx) => {
        await boxSh(ctx, ctx.box(), `printf 'made in box' > from-box.txt`);
        await ab(['download', ctx.box(), '-y'], {
          cwd: v(ctx).app,
          log: ctx.log,
          timeoutMs: 600_000,
        });
        const f = join(v(ctx).app, 'from-box.txt');
        if (!existsSync(f) || readFileSync(f, 'utf8') !== 'made in box')
          throw new Error(`${f} missing or wrong after download`);
      },
    },
    {
      name: 'a crashed web service is restarted',
      covers: ['CTL-010'],
      fn: async (ctx) => {
        const url = v(ctx).url;
        if (!url) throw new Error('no web URL from the earlier step');
        const before = await webJson(url);
        await boxSh(ctx, ctx.box(), `kill -9 ${String(before.pid)}`, { allowFail: true });
        const after = await poll(
          'the web service to come back with a new pid',
          async () => {
            const b = await webJson(url).catch(() => undefined);
            return b?.pid && b.pid !== before.pid ? b : undefined;
          },
          { timeoutMs: 120_000, intervalMs: 3000 },
        );
        ctx.note(`pid ${String(before.pid)} -> ${String(after.pid)}`);
      },
    },
    {
      name: '`top` reports the box',
      covers: ['TOP-001'],
      fn: async (ctx) => {
        const rows = await abJson<
          Array<{ name?: string; box?: string }> | { boxes?: Array<{ name?: string }> }
        >(['top', '-j'], { cwd: v(ctx).app, log: ctx.log, timeoutMs: 120_000 });
        const list = Array.isArray(rows) ? rows : (rows.boxes ?? []);
        if (!JSON.stringify(list).includes(ctx.box())) throw new Error(`top -j lacks ${ctx.box()}`);
      },
    },
  ],
  edges: [
    {
      name: '`wait` on a unit that never exists times out non-zero',
      covers: ['WAIT-003'],
      needs: ['`wait` returns once postgres and web are ready'],
      fn: async (ctx) => {
        const r = await ab(['wait', ctx.box(), '--units', 'no-such-unit', '--timeout', '5000'], {
          cwd: v(ctx).app,
          log: ctx.log,
          allowFail: true,
          timeoutMs: 120_000,
        });
        if (r.exitCode === 0) throw new Error('wait on a missing unit exited 0');
      },
    },
  ],
};
