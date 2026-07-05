/**
 * `agentbox install tray` — install the AgentBox Tray macOS menu-bar app.
 *
 * The tray ships as a signed+notarized `AgentBoxTray.app` zipped into the CLI's npm package at
 * `runtime/tray/AgentBoxTray.zip` (staged by `scripts/stage-runtime.mjs` at publish time). This
 * command unpacks it into `/Applications` with `ditto` (which preserves the code signature and the
 * stapled notarization ticket) and launches it. macOS-only; a clean no-op elsewhere.
 */

import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import { execa } from 'execa';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

export const APP_NAME = 'AgentBoxTray';
export const APP_PATH = `/Applications/${APP_NAME}.app`;

/** Locate the bundled tray zip, or null if it isn't staged (e.g. a dev checkout, or Linux). */
export function resolveTrayZip(): string | null {
  const candidates: string[] = [];
  if (process.env.AGENTBOX_CLI_RUNTIME_DIR) {
    candidates.push(join(process.env.AGENTBOX_CLI_RUNTIME_DIR, 'tray', `${APP_NAME}.zip`));
  }
  const selfDir = dirname(fileURLToPath(import.meta.url));
  candidates.push(resolve(selfDir, '..', 'runtime', 'tray', `${APP_NAME}.zip`));
  candidates.push(resolve(selfDir, '..', '..', 'runtime', 'tray', `${APP_NAME}.zip`));
  return candidates.find((p) => existsSync(p)) ?? null;
}

export interface InstallTrayResult {
  ran: boolean;
  reason?: string;
}

/** Install (or uninstall) the tray app. Reusable from the setup wizard. */
export async function installTray(
  opts: { uninstall?: boolean; quiet?: boolean } = {},
): Promise<InstallTrayResult> {
  const say = (msg: string) => {
    if (!opts.quiet) log.info(msg);
  };

  if (process.platform !== 'darwin') {
    say('The AgentBox menu-bar app is macOS-only — skipping.');
    return { ran: false, reason: 'not-macos' };
  }

  // Quit any running instance so we can replace the bundle cleanly.
  await execa('pkill', ['-x', APP_NAME]).catch(() => undefined);

  if (opts.uninstall) {
    if (existsSync(APP_PATH)) rmSync(APP_PATH, { recursive: true, force: true });
    say(`Removed ${APP_PATH}. (Launch-at-login is unregistered by the app itself.)`);
    return { ran: true };
  }

  const zip = resolveTrayZip();
  if (!zip) {
    say('Tray app not bundled in this CLI build (dev checkout?) — nothing to install.');
    return { ran: false, reason: 'not-bundled' };
  }

  // Replace any existing copy, extract with ditto (preserves signature + notarization ticket).
  if (existsSync(APP_PATH)) rmSync(APP_PATH, { recursive: true, force: true });
  await execa('ditto', ['-x', '-k', zip, '/Applications']);
  // Belt-and-suspenders: clear any quarantine bit so Gatekeeper never blocks the local install.
  await execa('xattr', ['-dr', 'com.apple.quarantine', APP_PATH]).catch(() => undefined);
  await execa('open', [APP_PATH]);

  say(`Installed ${APP_PATH} and launched it (look for the box icon in the menu bar).`);
  return { ran: true };
}

export const installTrayCommand = new Command('tray')
  .description('Install the AgentBox Tray macOS menu-bar app into /Applications and launch it')
  .option('--uninstall', 'quit and remove the menu-bar app')
  .action(async (opts: { uninstall?: boolean }) => {
    intro(opts.uninstall ? 'Removing AgentBox Tray…' : 'Installing AgentBox Tray…');
    const res = await installTray({ uninstall: opts.uninstall });
    outro(res.ran ? 'Done' : `Skipped (${res.reason ?? 'nothing to do'})`);
    if (!res.ran && res.reason === 'not-bundled') process.exitCode = 1;
  });
