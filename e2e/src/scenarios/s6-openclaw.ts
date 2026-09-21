import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { boxSh } from '../lib/box.js';
import { REPO_ROOT } from '../lib/env.js';
import { ab, poll, run } from '../lib/exec.js';
import { hubBox } from '../lib/hub.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';
import type { Target } from '../lib/targets.js';

const v = (ctx: Ctx) => ctx.vars as { app: string; url?: string; token?: string };

/** Where the service-agent surface is supported (docs/agents.md, test-plan CLAW-001). */
const CLAW_PROVIDERS = ['docker', 'hetzner', 'remote-docker'];
const skipUnsupported = (t: Target) =>
  CLAW_PROVIDERS.includes(t.provider) ? undefined : `openclaw runs on ${CLAW_PROVIDERS.join(', ')}`;

async function urlAndToken(ctx: Ctx, box: string): Promise<{ url: string; token: string }> {
  const out = (await ab(['openclaw', 'url', box], { cwd: v(ctx).app, log: ctx.log })).stdout;
  const url =
    out
      .split('\n')
      .find((l) => /^https?:\/\//.test(l.trim()))
      ?.trim() ?? '';
  const token = /token:\s*(\S+)/.exec(out)?.[1] ?? '';
  if (!url || !token) throw new Error(`openclaw url printed no URL/token:\n${out}`);
  return { url, token };
}

async function boxToken(ctx: Ctx, box: string): Promise<string> {
  const r = await boxSh(
    ctx,
    box,
    `node -e "console.log(require(process.env.HOME+'/.openclaw/openclaw.json').gateway.auth.token)"`,
  );
  return r.stdout.trim();
}

async function healthy(url: string): Promise<boolean> {
  const r = await fetch(`${url.replace(/\/$/, '')}/healthz`, {
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  return r?.status === 200;
}

export const s6: ScenarioDef = {
  id: 's6',
  title: 'Service agent (openclaw)',
  covers: ['CLAW-001', 'CLAW-002', 'CLAW-005', 'CLAW-006'],
  boxes: 1,
  skipOn: skipUnsupported,
  steps: [
    {
      name: 'openclaw reaches ready and its URL answers',
      covers: ['CLAW-001'],
      fn: async (ctx) => {
        const app = join(ctx.dir, 'openclaw-gateway');
        cpSync(join(REPO_ROOT, 'examples', 'openclaw-gateway'), app, { recursive: true });
        await run('git', ['init', '-q'], { cwd: app, log: ctx.log });
        await run('git', ['add', '-A'], { cwd: app, log: ctx.log });
        await run('git', ['commit', '-qm', 'e2e: openclaw'], { cwd: app, log: ctx.log });
        Object.assign(ctx.vars, { app });
        ctx.trackBox(ctx.box());
        await ab(
          [
            'openclaw',
            '--provider',
            ctx.target.providerArg,
            '-y',
            '-n',
            ctx.box(),
            '--carry',
            'skip',
          ],
          {
            cwd: app,
            log: ctx.log,
            timeoutMs: 30 * 60_000,
          },
        );
        const svc = await ab(['services', ctx.box()], { cwd: app, log: ctx.log, allowFail: true });
        if (!/openclaw/.test(svc.stdout))
          throw new Error(`services lacks openclaw:\n${svc.stdout}`);
        const { url, token } = await urlAndToken(ctx, ctx.box());
        Object.assign(ctx.vars, { url, token });
        await poll('openclaw /healthz to answer 200', async () => healthy(url), {
          timeoutMs: 180_000,
          intervalMs: 5000,
        });
      },
    },
    {
      name: '`openclaw url` prints the box’s real gateway token',
      covers: ['CLAW-002'],
      fn: async (ctx) => {
        const real = await boxToken(ctx, ctx.box());
        if (real !== v(ctx).token)
          throw new Error(
            `url token ${String(v(ctx).token).slice(0, 6)}… != box token ${real.slice(0, 6)}…`,
          );
      },
    },
    {
      name: 'the declared run-env reaches the box',
      covers: ['CLAW-006'],
      fn: async (ctx) => {
        const r = await boxSh(
          ctx,
          ctx.box(),
          `node -e "console.log(require(process.env.HOME+'/.openclaw/openclaw.json').agents.defaults.workspace)"`,
        );
        if (r.stdout.trim() !== '/workspace')
          throw new Error(`agents.defaults.workspace is "${r.stdout.trim()}", want /workspace`);
      },
    },
    {
      name: 'back up the bot, destroy it, restore it with the same identity',
      fn: async (ctx) => {
        await ab(['download', ctx.box(), '--backup', '-y'], {
          cwd: v(ctx).app,
          log: ctx.log,
          timeoutMs: 20 * 60_000,
        });
        await ab(['destroy', '-y', '--force', ctx.box()], {
          cwd: v(ctx).app,
          log: ctx.log,
          timeoutMs: 20 * 60_000,
        });
        if (await hubBox(ctx.box())) throw new Error('bot still listed after destroy');
        const into = join(ctx.dir, 'restored');
        await ab(
          [
            'openclaw',
            '--provider',
            ctx.target.providerArg,
            '--restore',
            ctx.box(),
            // Without -n the restored bot is named `restored-<id>`, not after the bot.
            '-n',
            ctx.box(),
            '-y',
            '--into',
            into,
          ],
          { cwd: v(ctx).app, log: ctx.log, timeoutMs: 30 * 60_000 },
        );
        const after = await urlAndToken(ctx, ctx.box());
        if (after.token !== v(ctx).token)
          throw new Error('the restored bot has a new gateway token (identity lost)');
        await poll('the restored bot to answer /healthz', async () => healthy(after.url), {
          timeoutMs: 180_000,
          intervalMs: 5000,
        });
      },
    },
  ],
  edges: [
    {
      name: 'the gateway identity never leaves the box on download',
      covers: ['CLAW-005'],
      needs: ['openclaw reaches ready and its URL answers'],
      fn: async (ctx) => {
        const r = await ab(['download', 'openclaw', ctx.box(), '--dry-run'], {
          cwd: v(ctx).app,
          log: ctx.log,
          allowFail: true,
        });
        const out = r.stdout + r.stderr;
        const leaked = ['openclaw.json', 'config-journal-fingerprint.key', 'state/'].filter((f) =>
          out.includes(f),
        );
        if (leaked.length) throw new Error(`download openclaw would copy ${leaked.join(', ')}`);
      },
    },
  ],
};
