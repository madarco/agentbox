import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTBOX_BIN, E2E_HOME, E2E_PREFIX, REPO_ROOT } from './env.js';
import { poll, run } from './exec.js';
import type { Ctx } from './runner.js';

const TRAY_REPO = join(REPO_ROOT, '..', 'agentbox-tray');
/** A second bundle id + process name, so the user's own tray is never touched. */
const E2E_APP_BIN = join(TRAY_REPO, 'AgentBoxE2E.app', 'Contents', 'MacOS', 'AgentBoxE2E');
const DRIVER_DIR = join(REPO_ROOT, 'e2e', 'tray-driver');
const DRIVER = join(DRIVER_DIR, '.build', 'release', 'tray-driver');

/** The user must be away from the Mac this long before the menu is opened on screen. */
const IDLE_BEFORE_UI_SECONDS = 60;

export function trayAvailable(): boolean {
  return process.platform === 'darwin' && existsSync(TRAY_REPO);
}

async function ensureBuilt(log: string): Promise<void> {
  if (!existsSync(E2E_APP_BIN))
    await run('make', ['e2e-app'], { cwd: TRAY_REPO, log, timeoutMs: 20 * 60_000 });
  if (!existsSync(DRIVER))
    await run('swift', ['build', '-c', 'release'], {
      cwd: DRIVER_DIR,
      log,
      timeoutMs: 20 * 60_000,
    });
}

async function driver<T>(args: string[], log: string, allowFail = false): Promise<T> {
  const r = await run(DRIVER, args, { log, allowFail: true, timeoutMs: 60_000 });
  const out = JSON.parse(r.stdout.trim() || '{}') as T & { ok?: boolean; error?: string };
  if (r.exitCode !== 0 && !allowFail)
    throw new Error(`tray-driver ${args[0] ?? ''}: ${out.error ?? r.stderr}`);
  return out;
}

interface Frontmost {
  bundleId?: string;
  screenLocked?: boolean;
  idleSeconds?: number;
  axTrusted?: boolean;
}

interface AxElement {
  found?: boolean;
  identifier?: string;
  title?: string;
  label?: string;
  value?: string;
}

/**
 * Launch the e2e tray against the e2e hub. It is exec'd directly: `open` would go
 * through launchd and drop HOME / AGENTBOX_BIN. The first-launch popups are switched off
 * so the test never steals focus from whatever the user is doing.
 */
async function launch(ctx: Ctx): Promise<number> {
  await ensureBuilt(ctx.log);
  const child = spawn(
    E2E_APP_BIN,
    ['-SetupWizardSeen', 'YES', '-LastSeenWhatsNewVersion', '999.0.0'],
    {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        HOME: E2E_HOME,
        AGENTBOX_BIN,
        PATH: `${join(E2E_PREFIX, 'bin')}:${process.env['PATH'] ?? ''}`,
        AGENTBOX_TRAY_NO_NOTIFICATIONS: '1',
      },
    },
  );
  child.unref();
  if (!child.pid) throw new Error('the e2e tray did not start');
  return child.pid;
}

/**
 * Find a box's row in the e2e tray's menu and capture evidence of it. The menu's AX
 * tree is readable while it is closed, so the lookup never touches the screen. The
 * menu is only opened for a screenshot when the user has been idle for a minute and
 * the screen is unlocked; otherwise the AX entry itself is the evidence.
 */
export async function trayBoxRow(
  ctx: Ctx,
  box: string,
): Promise<{ title: string; screenshot: string }> {
  const pid = await launch(ctx);
  try {
    const id = `agentbox.box.${box}`;
    const el = await poll(
      `tray row ${id}`,
      async () => {
        const e = await driver<AxElement>(
          ['find', '--pid', String(pid), '--id', id, '--timeout', '2'],
          ctx.log,
          true,
        );
        return e.found ? e : undefined;
      },
      { timeoutMs: 90_000, intervalMs: 3000 },
    );
    const title = el.title ?? el.label ?? '';
    const front = await driver<Frontmost>(['frontmost'], ctx.log);
    const idle = (front.idleSeconds ?? 0) >= IDLE_BEFORE_UI_SECONDS && !front.screenLocked;
    if (idle && front.axTrusted) {
      await driver(['open-menu', '--pid', String(pid)], ctx.log);
      const png = join(ctx.dir, 'tray-menu.png');
      try {
        await driver(['screenshot', '--pid', String(pid), '--out', png], ctx.log);
      } finally {
        await driver(['close-menu', '--pid', String(pid)], ctx.log, true);
      }
      return { title, screenshot: png };
    }
    ctx.note(
      `menu not opened on screen (${front.screenLocked ? 'screen locked' : `user active ${String(front.idleSeconds)}s ago`}); judged the AX entry`,
    );
    const tree = await driver<unknown>(
      ['tree', '--pid', String(pid), '--depth', '8'],
      ctx.log,
      true,
    );
    const txt = join(ctx.dir, 'tray-ax.json');
    writeFileSync(txt, `${JSON.stringify({ row: el, tree }, null, 2)}\n`);
    return { title, screenshot: txt };
  } finally {
    try {
      process.kill(pid);
    } catch {
      // already gone
    }
  }
}
