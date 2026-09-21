import { join } from 'node:path';
import { createBox } from '../lib/box.js';
import { browserAvailable, screenshot } from '../lib/browser.js';
import { PtySession, driveAvailable } from '../lib/drive.js';
import { AGENTBOX_BIN } from '../lib/env.js';
import { ab, poll } from '../lib/exec.js';
import { cloneTestRepo } from '../lib/github.js';
import { hubTarget } from '../lib/hub.js';
import { judge } from '../lib/judge.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';
import { trayAvailable, trayBoxRow } from '../lib/tray.js';

const v = (ctx: Ctx) => ctx.vars as { repo: string };

export const s8: ScenarioDef = {
  id: 's8',
  title: 'Interactive surfaces',
  covers: ['DASH-001', 'DASH-002', 'DASH-003', 'SHELL-001'],
  boxes: 1,
  // Terminal UIs, the hub web UI and the tray are host surfaces over the same hub API;
  // one Mac target exercises them.
  skipOn: (t) =>
    t.id === 'docker@mac' ? undefined : 'the interactive surfaces run once, on docker@mac',
  steps: [
    {
      name: 'create a box',
      fn: async (ctx) => {
        const repo = join(ctx.dir, 'repo');
        await cloneTestRepo(repo, ctx.log);
        Object.assign(ctx.vars, { repo });
        await createBox(ctx, ctx.box(), repo);
      },
    },
    {
      name: '`shell -- <cmd>` runs a one-shot command',
      covers: ['SHELL-001'],
      fn: async (ctx) => {
        const r = await ab(['shell', ctx.box(), '--', 'bash', '-lc', 'echo one-shot-$((6*7))'], {
          cwd: v(ctx).repo,
          log: ctx.log,
        });
        if (!r.stdout.includes('one-shot-42')) throw new Error(`shell printed: ${r.stdout}`);
      },
    },
    {
      name: 'the dashboard lists the box and quits cleanly',
      group: 'dashboard',
      covers: ['DASH-001', 'DASH-002', 'DASH-003'],
      skipOn: () => (driveAvailable() ? undefined : 'needs the PTY harness (monorepo checkout)'),
      fn: async (ctx) => {
        const pty = await PtySession.start({
          name: 'dash',
          cmd: AGENTBOX_BIN,
          args: ['dashboard'],
          cwd: v(ctx).repo,
          log: ctx.log,
        });
        try {
          await pty.waitFor(ctx.box().slice(0, 20), 60_000);
          const shot = join(ctx.dir, 'dashboard.txt');
          await pty.capture(shot);
          await judge(
            ctx,
            shot,
            `A terminal dashboard whose sidebar lists a box named "${ctx.box()}" (possibly truncated) with its state.`,
          );
          await pty.send('<C-a>');
          await new Promise((r) => setTimeout(r, 1500));
          const menu = join(ctx.dir, 'dashboard-leader.txt');
          await pty.capture(menu);
          ctx.evidence(menu);
          await pty.send('q');
          await poll(
            'the dashboard to exit',
            async () => (await pty.screen().catch(() => 'EXITED')) === 'EXITED',
            { timeoutMs: 20_000, intervalMs: 1000 },
          );
        } finally {
          await pty.stop();
        }
      },
    },
    {
      name: 'the hub web UI lists the box',
      group: 'web',
      skipOn: () =>
        browserAvailable() ? undefined : 'needs Google Chrome for a headless screenshot',
      fn: async (ctx) => {
        const t = await hubTarget();
        const out = join(ctx.dir, 'hub-web.png');
        await screenshot(`${t.url}/?token=${t.token}`, out, ctx.log);
        await judge(
          ctx,
          out,
          `The AgentBox hub web UI in a browser, showing a list of boxes that includes one named "${ctx.box()}".`,
        );
      },
    },
    {
      name: 'the menu-bar app shows the box',
      group: 'tray',
      skipOn: (_t, opts) =>
        !opts.tray
          ? 'tray steps disabled (--no-tray)'
          : trayAvailable()
            ? undefined
            : 'the e2e tray build or driver is missing',
      fn: async (ctx) => {
        const row = await trayBoxRow(ctx, ctx.box());
        await judge(
          ctx,
          row.screenshot,
          `A macOS menu-bar dropdown for AgentBox listing a box named "${ctx.box()}" with its state.`,
        );
      },
    },
  ],
};
