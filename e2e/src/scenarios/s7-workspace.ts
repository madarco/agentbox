import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { queueAgentBox, waitForBoxCommit } from '../lib/box.js';
import { E2E_HOME } from '../lib/env.js';
import { ab, abJson, poll, run } from '../lib/exec.js';
import { cloneTestRepo, createBaseBranch, prForHead } from '../lib/github.js';
import { hubBox, hubJson } from '../lib/hub.js';
import { judge } from '../lib/judge.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';

interface S7Vars {
  ws: string;
  wsId: string;
  repo: string;
  base: string;
  task: string;
  pr?: number;
  managerId?: string;
}
const v = (ctx: Ctx) => ctx.vars as unknown as S7Vars;

interface Manager {
  id: string;
  workspaceId?: string;
  state?: string;
  running?: boolean;
  tmuxSession?: string;
  [k: string]: unknown;
}

export const s7: ScenarioDef = {
  id: 's7',
  title: 'Workspace, tasks and manager',
  covers: [],
  boxes: 1,
  // The workspace layer is host-side and provider-agnostic; one target exercises it.
  skipOn: (t) =>
    t.id === 'docker@mac' ? undefined : 'the workspace layer runs once, on docker@mac',
  steps: [
    {
      name: 'register a workspace folder over two projects',
      fn: async (ctx) => {
        const ws = join(ctx.dir, 'workspace');
        const repo = join(ws, 'agentbox-test-repo');
        await cloneTestRepo(repo, ctx.log);
        const other = join(ws, 'notes');
        mkdirSync(other, { recursive: true });
        writeFileSync(join(other, 'README.md'), '# notes\n');
        await run('git', ['init', '-q'], { cwd: other, log: ctx.log });
        await run('git', ['add', '-A'], { cwd: other, log: ctx.log });
        await run('git', ['commit', '-qm', 'init'], { cwd: other, log: ctx.log });
        const w = await abJson<{ id: string; projects?: unknown[] }>(
          ['workspace', 'add', ws, '--name', `e2e-${ctx.opts.runId}`, '-j'],
          { cwd: ws, log: ctx.log },
        );
        if ((w.projects ?? []).length < 2)
          throw new Error(`workspace found ${String((w.projects ?? []).length)} projects, want 2`);
        const base = `e2e/${ctx.opts.runId}/${ctx.target.slug}-s7`;
        await createBaseBranch(base, ctx.log);
        Object.assign(ctx.vars, { ws, wsId: w.id, repo, base, task: '' } satisfies S7Vars);
      },
    },
    {
      name: 'add a task and start a box for it',
      fn: async (ctx) => {
        const t = await abJson<{ id: string }>(
          ['tasks', 'add', '-w', v(ctx).ws, '-j', 'Add the e2e hello file'],
          {
            cwd: v(ctx).repo,
            log: ctx.log,
          },
        );
        v(ctx).task = t.id;
        await queueAgentBox(ctx, {
          agent: 'claude',
          name: ctx.box(),
          cwd: v(ctx).repo,
          extra: ['--tasks', t.id],
          prompt:
            'Create a file named e2e-ws.txt containing the line "workspace". Then run exactly: ' +
            'git add e2e-ws.txt && git commit -m "e2e: workspace task" e2e-ws.txt. Then stop.',
        });
        const shown = await abJson<{ boxId?: string; box?: string; status?: string }>(
          ['tasks', 'show', t.id, '-w', v(ctx).ws, '-j'],
          {
            cwd: v(ctx).repo,
            log: ctx.log,
          },
        );
        const box = await hubBox(ctx.box());
        if (!box || !JSON.stringify(shown).includes(box.id))
          throw new Error(`task ${t.id} is not assigned to ${ctx.box()}: ${JSON.stringify(shown)}`);
      },
    },
    {
      name: 'the task’s PR shows up merged on the workspace timeline',
      fn: async (ctx) => {
        await waitForBoxCommit(ctx, ctx.box(), 'e2e: workspace task');
        await ab(['git', 'push', ctx.box()], {
          cwd: v(ctx).repo,
          log: ctx.log,
          timeoutMs: 300_000,
        });
        await ab(
          [
            'git',
            'pr',
            'create',
            ctx.box(),
            '--base',
            v(ctx).base,
            '--title',
            'e2e: workspace task',
            '--body',
            'e2e',
          ],
          {
            cwd: v(ctx).repo,
            log: ctx.log,
          },
        );
        const pr = await prForHead(`agentbox/${ctx.box()}`, ctx.log);
        if (!pr) throw new Error('no PR');
        v(ctx).pr = pr.number;
        await ab(['git', 'pr', 'merge', ctx.box(), String(pr.number), '--squash'], {
          cwd: v(ctx).repo,
          log: ctx.log,
        });
        const timeline = await poll(
          `PR #${String(pr.number)} merged on the timeline`,
          async () => {
            const t = await hubJson<unknown>(`/api/v1/workspaces/${v(ctx).wsId}/timeline`);
            const s = JSON.stringify(t);
            return s.includes(`"number":${String(pr.number)}`) && /merged/i.test(s) ? t : undefined;
          },
          { timeoutMs: 5 * 60_000, intervalMs: 10_000 },
        );
        writeFileSync(join(ctx.dir, 'timeline.json'), `${JSON.stringify(timeline, null, 2)}\n`);
        ctx.evidence(join(ctx.dir, 'timeline.json'));
        const box = await poll(
          'Box.pr to read merged',
          async () => {
            const b = await hubBox(ctx.box());
            return b?.pr?.number === pr.number && b.pr.state === 'merged' ? b : undefined;
          },
          { timeoutMs: 3 * 60_000, intervalMs: 10_000 },
        );
        ctx.note(`Box.pr ${JSON.stringify(box.pr)}`);
      },
    },
    {
      name: 'the hub runs a manager for the workspace and delivers a message to it',
      fn: async (ctx) => {
        await ab(['manager', 'start', '-w', v(ctx).ws, '--new'], {
          cwd: v(ctx).ws,
          log: ctx.log,
          timeoutMs: 180_000,
        });
        const m = await poll(
          'a running hub manager for the workspace',
          async () => {
            const r = await hubJson<{ managers?: Manager[] } | Manager[]>('/api/v1/managers');
            const list = Array.isArray(r) ? r : (r.managers ?? []);
            return list.find((x) => x.workspaceId === v(ctx).wsId && x.tmuxSession);
          },
          { timeoutMs: 120_000, intervalMs: 3000 },
        );
        v(ctx).managerId = m.id;
        await ab(
          ['manager', 'message', m.id, 'Reply with the single word PONG and nothing else.'],
          {
            cwd: v(ctx).ws,
            log: ctx.log,
          },
        );
        const pane = await poll(
          'the manager to answer',
          async () => {
            const r = await run('tmux', ['capture-pane', '-p', '-t', String(m.tmuxSession)], {
              env: { TMUX_TMPDIR: join(E2E_HOME, 'tmux') },
              log: ctx.log,
              allowFail: true,
            });
            return /PONG/.test(r.stdout.split('Reply with the single word')[1] ?? '')
              ? r.stdout
              : undefined;
          },
          { timeoutMs: 180_000, intervalMs: 5000 },
        );
        const p = join(ctx.dir, 'manager-pane.txt');
        writeFileSync(p, pane);
        await judge(
          ctx,
          p,
          'A Claude Code session (the workspace manager) that received the message "Reply with the single word PONG" and answered PONG.',
        );
      },
    },
    {
      name: 'finish the task',
      fn: async (ctx) => {
        await ab(['tasks', 'done', v(ctx).task, '-w', v(ctx).ws], {
          cwd: v(ctx).repo,
          log: ctx.log,
        });
        const t = await abJson<{ status?: string }>(
          ['tasks', 'show', v(ctx).task, '-w', v(ctx).ws, '-j'],
          { cwd: v(ctx).repo, log: ctx.log },
        );
        if (t.status !== 'done') throw new Error(`task status ${String(t.status)}`);
      },
    },
  ],
  teardown: async (ctx) => {
    if (v(ctx).managerId)
      await ab(['manager', 'stop', v(ctx).managerId ?? ''], { log: ctx.log, allowFail: true });
    if (v(ctx).ws)
      await ab(['workspace', 'rm', v(ctx).ws, '--force'], { log: ctx.log, allowFail: true });
  },
};
