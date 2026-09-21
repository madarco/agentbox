import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { PtySession, driveAvailable } from '../lib/drive.js';
import { AGENTBOX_BIN, E2E_HOME, E2E_HUB_PORT, E2E_ROOT, killStaleHub } from '../lib/env.js';
import { ab, poll, run } from '../lib/exec.js';
import { hubFetch, hubTarget } from '../lib/hub.js';
import { judge } from '../lib/judge.js';
import type { Ctx, ScenarioDef } from '../lib/runner.js';
import { LINUX_VM_ALIAS, type Target } from '../lib/targets.js';

/** Target-independent checks run once per host, on its docker target. */
const primaryOnly = (t: Target): string | undefined =>
  t.kind === 'docker' ? undefined : `host-level check; runs on docker@${t.host}`;

const WIZARD_HOME = join(E2E_ROOT, 'wizard-home');
/**
 * The wizard's own hub. Must be set in the scratch config: the CLI pins the port from
 * the effective `relay.port` (default 8787) and ignores AGENTBOX_RELAY_PORT, so an
 * unset scratch config would reclaim 8787 and kill the user's real hub.
 */
const WIZARD_HUB_PORT = 8798;

function preparedFile(t: Target): string {
  return join(E2E_HOME, '.agentbox', `${t.provider}-prepared.json`);
}

/** The `<provider>:` block of `prepare --status`. */
function statusBlock(out: string, provider: string): string {
  const lines = out.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${provider}:`);
  if (start < 0) return '';
  const end = lines.findIndex((l, i) => i > start && /^\S.*:$/.test(l));
  return lines.slice(start, end < 0 ? undefined : end).join('\n');
}

function lanIp(): string | undefined {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

async function port8787Owner(): Promise<string> {
  const r = await run('lsof', ['-nP', '-iTCP:8787', '-sTCP:LISTEN', '-t'], { allowFail: true });
  return r.stdout.trim();
}

async function wizard(ctx: Ctx): Promise<void> {
  const before = await port8787Owner();
  killStaleHub(WIZARD_HUB_PORT, WIZARD_HOME);
  rmSync(WIZARD_HOME, { recursive: true, force: true });
  mkdirSync(join(WIZARD_HOME, '.agentbox'), { recursive: true });
  writeFileSync(
    join(WIZARD_HOME, '.agentbox', 'config.yaml'),
    `schema: 1\nrelay:\n  port: ${String(WIZARD_HUB_PORT)}\n`,
  );
  const env = {
    HOME: WIZARD_HOME,
    AGENTBOX_HOME: join(WIZARD_HOME, '.agentbox'),
    AGENTBOX_RELAY_PORT: String(WIZARD_HUB_PORT),
  };

  const pty = await PtySession.start({
    name: 'wizard',
    cmd: 'env',
    args: Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .concat([AGENTBOX_BIN, 'install']),
    cwd: WIZARD_HOME,
    log: ctx.log,
  });
  const shot = async (n: string) => {
    const p = join(ctx.dir, `wizard-${n}.txt`);
    await pty.capture(p).catch(() => undefined);
    ctx.evidence(p);
  };
  try {
    await pty.waitFor('Which provider', 30_000);
    await shot('1-provider');
    await pty.send('<Enter>');
    await pty.waitFor('Build the box image', 30_000);
    await pty.send('<Enter>');
    // After the bake the wizard installs skills, then offers the menu-bar app. Decline:
    // the test must not install or update the user's /Applications/AgentBox.app.
    const offer = await poll(
      'the wizard to finish the bake and reach the menu-bar step',
      async () => {
        const s = await pty.screen().catch(() => 'EXITED');
        if (/menu-bar app/.test(s)) return 'offer';
        if (s === 'EXITED') return 'exited';
        if (/create failed|prepare failed|bake failed/i.test(s))
          throw new Error(`wizard error:\n${s}`);
        return undefined;
      },
      { timeoutMs: 20 * 60_000, intervalMs: 3000 },
    );
    await shot('2-after-bake');
    if (offer === 'offer') {
      await pty.send('<Right>');
      await pty.send('<Enter>');
    }
    // The tutorial outro is the last screen; capture it before the process exits.
    await poll(
      'the wizard to exit',
      async () => {
        const s = await pty.screen().catch(() => 'EXITED');
        if (s !== 'EXITED') writeFileSync(join(ctx.dir, 'wizard-3-final.txt'), s);
        return s === 'EXITED' || /Start a box|agentbox claude/.test(s) ? true : undefined;
      },
      { timeoutMs: 5 * 60_000, intervalMs: 1000 },
    );
  } finally {
    await pty.stop();
    await run(AGENTBOX_BIN, ['hub', 'stop'], { env, log: ctx.log, allowFail: true });
  }
  if (existsSync(join(ctx.dir, 'wizard-3-final.txt')))
    ctx.evidence(join(ctx.dir, 'wizard-3-final.txt'));

  const state = join(WIZARD_HOME, '.agentbox');
  const missing = ['docker-prepared.json', 'setup-complete.json'].filter(
    (f) => !existsSync(join(state, f)),
  );
  if (missing.length) throw new Error(`the wizard did not write ${missing.join(', ')}`);
  const skills = join(WIZARD_HOME, '.claude', 'skills');
  if (!existsSync(skills) || !readdirSync(skills).some((d) => d.startsWith('agentbox')))
    throw new Error(`no agentbox skill installed under ${skills}`);
  const after = await port8787Owner();
  if (before && after !== before)
    throw new Error(`port 8787 changed owner during the wizard (${before} -> ${after || 'none'})`);
  if (existsSync(join(ctx.dir, 'wizard-3-final.txt'))) {
    await judge(
      ctx,
      join(ctx.dir, 'wizard-3-final.txt'),
      'An `agentbox install` wizard that finished setting up the Docker provider: it shows the image was prepared ' +
        'and ends on a completion / next-steps screen, with no error or failure message.',
    );
  }
}

export const s1: ScenarioDef = {
  id: 's1',
  title: 'Fresh install and first bake',
  covers: [
    'BOOT-001',
    'BOOT-002',
    'PREP-001',
    'PREP-002',
    'PREP-004',
    'PREP-005',
    'PREP-006',
    'RELAY-004',
    'RELAY-005',
    'RELAY-006',
  ],
  boxes: 0,
  steps: [
    {
      name: 'the packed CLI installs and prints its help',
      covers: ['BOOT-001', 'BOOT-002'],
      group: 'cli',
      skipOn: primaryOnly,
      fn: async (ctx) => {
        const v = (await ab(['--version'], { log: ctx.log })).stdout.trim();
        if (!/^\d+\.\d+\.\d+/.test(v)) throw new Error(`--version printed "${v}"`);
        const bare = await ab([], { log: ctx.log, allowFail: true });
        if (!(bare.stdout + bare.stderr).includes('claude'))
          throw new Error('bare `agentbox` printed no help');
        const full = await ab(['help'], { log: ctx.log, allowFail: true });
        const missing = ['claude', 'create', 'prepare', 'hub', 'checkpoint'].filter(
          (c) => !full.stdout.includes(c),
        );
        if (full.exitCode !== 0 || missing.length)
          throw new Error(
            `\`agentbox help\` exited ${String(full.exitCode)}; lacks ${missing.join(', ')}`,
          );
        ctx.note(`CLI ${v}; bare \`agentbox\` exits ${String(bare.exitCode)}`);
      },
    },
    {
      name: 'the install wizard sets up Docker from scratch',
      group: 'wizard',
      skipOn: (t) =>
        t.id !== 'docker@mac'
          ? 'the wizard runs once, on docker@mac'
          : driveAvailable()
            ? undefined
            : 'needs the PTY harness (monorepo checkout)',
      fn: wizard,
    },
    {
      name: 'the hub answers /healthz and gates /api/v1',
      covers: ['RELAY-004'],
      group: 'hub',
      skipOn: primaryOnly,
      fn: async (ctx) => {
        const t = await hubTarget();
        if (!t.url.endsWith(`:${String(E2E_HUB_PORT)}`))
          throw new Error(`hub target is ${t.url}, want port ${String(E2E_HUB_PORT)}`);
        const health = await fetch(`${t.url}/healthz`);
        const anon = await hubFetch('/api/v1/boxes', { token: null });
        const authed = await hubFetch('/api/v1/boxes');
        const got = `healthz ${String(health.status)}, anonymous /api/v1/boxes ${String(anon.status)}, with token ${String(authed.status)}`;
        if (health.status !== 200 || anon.status !== 401 || authed.status !== 200)
          throw new Error(got);
        ctx.note(got);
      },
    },
    {
      name: 'provider credentials are configured',
      group: 'bake',
      skipOn: (t) => (t.kind === 'docker' ? 'docker needs no login' : undefined),
      fn: async (ctx) => {
        if (ctx.target.kind === 'remote-docker') {
          await ab(['remote-docker', 'add', LINUX_VM_ALIAS, LINUX_VM_ALIAS], {
            log: ctx.log,
            allowFail: true,
          });
          await ab(['remote-docker', 'doctor', LINUX_VM_ALIAS], {
            log: ctx.log,
            timeoutMs: 120_000,
          });
          return;
        }
        const r = await ab([ctx.target.provider, 'login', '--status'], {
          log: ctx.log,
          allowFail: true,
        });
        const text = r.stdout + r.stderr;
        if (r.exitCode !== 0 || /not configured|not set|missing/i.test(text))
          throw new Error(`login --status:\n${text}`);
      },
    },
    {
      name: 'bake the base image',
      group: 'bake',
      covers: ['PREP-001', 'PREP-004', 'PREP-005'],
      fn: async (ctx) => {
        const reuse = ctx.opts.reuseBake && existsSync(preparedFile(ctx.target));
        if (reuse) {
          ctx.note('reused the previous bake (--reuse-bake)');
        } else {
          await ab(['prepare', '--provider', ctx.target.providerArg, '--force', '-y'], {
            log: ctx.log,
            timeoutMs: 90 * 60_000,
          });
        }
        if (ctx.target.kind !== 'remote-docker' && !existsSync(preparedFile(ctx.target)))
          throw new Error(`no ${preparedFile(ctx.target)} after prepare`);
        const status = await ab(['prepare', '--status'], { log: ctx.log, timeoutMs: 180_000 });
        const block = statusBlock(status.stdout, ctx.target.provider);
        writeFileSync(join(ctx.dir, 'prepare-status.txt'), block || status.stdout);
        ctx.evidence(join(ctx.dir, 'prepare-status.txt'));
        if (/no base|not baked|no agentbox template|run `agentbox prepare/i.test(block))
          throw new Error(`prepare --status still reports no bake:\n${block}`);
      },
    },
    {
      name: 'prepare again is a fast no-op',
      group: 'bake',
      covers: ['PREP-002'],
      fn: async (ctx) => {
        const r = await ab(['prepare', '--provider', ctx.target.providerArg, '-y'], {
          log: ctx.log,
          timeoutMs: 20 * 60_000,
        });
        if (r.durationMs > 120_000)
          throw new Error(
            `a second prepare took ${String(Math.round(r.durationMs / 1000))}s; it should skip`,
          );
        ctx.note(`${String(Math.round(r.durationMs / 1000))}s`);
      },
    },
  ],
  edges: [
    {
      name: 'relay admin endpoints refuse a non-loopback caller',
      covers: ['RELAY-005'],
      skipOn: primaryOnly,
      fn: async (ctx) => {
        const ip = lanIp();
        if (!ip) {
          ctx.note('no LAN address; skipped');
          return;
        }
        const r = await fetch(`http://${ip}:${String(E2E_HUB_PORT)}/admin/prompts`);
        if (r.status !== 403)
          throw new Error(`GET /admin/prompts from ${ip} returned ${String(r.status)}, want 403`);
      },
    },
    {
      name: '/rpc refuses a request without a box bearer',
      covers: ['RELAY-006'],
      skipOn: primaryOnly,
      fn: async () => {
        const r = await fetch(`http://127.0.0.1:${String(E2E_HUB_PORT)}/rpc`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ method: 'git.push', params: {} }),
        });
        if (r.status !== 401 && r.status !== 403)
          throw new Error(`POST /rpc without a bearer returned ${String(r.status)}`);
      },
    },
  ],
};
