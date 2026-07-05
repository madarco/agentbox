/**
 * `agentbox app` — start / stop / restart / status for the AgentBox Tray macOS menu-bar app.
 *
 * Drives the running process directly (`open` / `pkill` / `pgrep`) without touching the installed
 * bundle — the lightweight lifecycle control the tray otherwise lacks (only `agentbox install tray`
 * relaunches it). macOS-only; a clean, explained no-op elsewhere. The bundle install/uninstall lives
 * in `install-tray.ts`, which owns `APP_NAME` / `APP_PATH`.
 */

import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { APP_NAME, APP_PATH } from './install-tray.js';

/** True on macOS; otherwise print the standard no-op notice and let the caller return. */
function ensureMac(): boolean {
  if (process.platform === 'darwin') return true;
  log.info('The AgentBox menu-bar app is macOS-only.');
  return false;
}

/** PIDs of the running tray process, or [] if none. `pgrep` exits 1 (throws) when nothing matches. */
async function trayPids(): Promise<number[]> {
  const res = await execa('pgrep', ['-x', APP_NAME]).catch(() => null);
  if (!res) return [];
  return res.stdout
    .split('\n')
    .map((l) => Number(l.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function startTray(): Promise<void> {
  await execa('open', [APP_PATH]);
}

async function stopTray(): Promise<void> {
  // `pkill` exits 1 when there was nothing to kill — not an error for us.
  await execa('pkill', ['-x', APP_NAME]).catch(() => undefined);
}

/** True only when the bundle is present; guard `start`/`restart` and point at the installer. */
function ensureInstalled(): boolean {
  if (existsSync(APP_PATH)) return true;
  log.error(`${APP_PATH} is not installed. Run \`agentbox install tray\` first.`);
  process.exitCode = 1;
  return false;
}

interface StatusOpts {
  json?: boolean;
}

const statusSub = new Command('status')
  .description('Show whether the AgentBox Tray app is running, with pid(s)')
  .option('--json', 'emit { running, pids, installed, appPath } as JSON')
  .action(async (opts: StatusOpts) => {
    const mac = process.platform === 'darwin';
    const pids = mac ? await trayPids() : [];
    const installed = mac && existsSync(APP_PATH);
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ running: pids.length > 0, pids, installed, appPath: APP_PATH }, null, 2) +
          '\n',
      );
      return;
    }
    if (!ensureMac()) return;
    if (pids.length) {
      log.info(`AgentBox Tray is running (pid ${pids.join(', ')}).`);
    } else if (installed) {
      log.info('AgentBox Tray is installed but not running.');
    } else {
      log.warn('AgentBox Tray is not installed. Run `agentbox install tray`.');
    }
  });

const startSub = new Command('start')
  .description('Launch the AgentBox Tray app if it is not already running')
  .action(async () => {
    if (!ensureMac()) return;
    intro('Starting AgentBox Tray…');
    if ((await trayPids()).length) {
      outro('Already running');
      return;
    }
    if (!ensureInstalled()) {
      outro('Not started'); // close the clack session the `intro` above opened
      return;
    }
    await startTray();
    outro('Started (look for the box icon in the menu bar)');
  });

const stopSub = new Command('stop')
  .description('Quit the running AgentBox Tray app (idempotent)')
  .action(async () => {
    if (!ensureMac()) return;
    intro('Stopping AgentBox Tray…');
    if (!(await trayPids()).length) {
      outro('Not running');
      return;
    }
    await stopTray();
    outro('Stopped');
  });

const restartSub = new Command('restart')
  .description('Quit and relaunch the AgentBox Tray app')
  .action(async () => {
    if (!ensureMac()) return;
    if (!ensureInstalled()) return;
    intro('Restarting AgentBox Tray…');
    await stopTray();
    // Wait for the old process to actually exit before relaunching, else `open`
    // may just foreground the still-quitting instance.
    for (let i = 0; i < 20 && (await trayPids()).length; i++) await delay(100);
    await startTray();
    outro('Restarted');
  });

export const appCommand = new Command('app')
  .description('Control the AgentBox Tray menu-bar app (status / start / stop / restart)')
  .addCommand(statusSub, { isDefault: true })
  .addCommand(startSub)
  .addCommand(stopSub)
  .addCommand(restartSub);
