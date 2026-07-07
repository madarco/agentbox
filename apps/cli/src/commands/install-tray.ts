/**
 * `agentbox install tray` — install the AgentBox Tray macOS menu-bar app.
 *
 * The tray is distributed separately (it's macOS-only, and keeps this cross-platform CLI small):
 * a signed+notarized `AgentBoxTray.zip` is published to the public `madarco/agentbox` repo under the
 * moving `tray-latest` release. This command downloads it, verifies its SHA-256, unpacks it into
 * `/Applications` with `ditto` (which preserves the signature + stapled notarization ticket), and
 * launches it. macOS-only; a clean no-op elsewhere.
 *
 * Humans who prefer no CLI can instead download `AgentBoxTray.dmg` from the same release and drag it
 * to Applications.
 */

import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import { execa } from 'execa';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const APP_NAME = 'AgentBoxTray';
export const APP_PATH = `/Applications/${APP_NAME}.app`;

// Overridable for forks/testing; default is the public agentbox repo's moving tray release.
const RELEASE_BASE =
  process.env.AGENTBOX_TRAY_RELEASE_BASE ?? 'https://github.com/madarco/agentbox/releases/download';
const DEFAULT_TAG = 'tray-latest';

export interface InstallTrayResult {
  ran: boolean;
  reason?: string;
}

export interface InstallTrayOptions {
  uninstall?: boolean;
  quiet?: boolean;
  /** Install a local zip instead of downloading (dev/offline). */
  zip?: string;
  /** Release tag to download from (default `tray-latest`; e.g. `tray-v0.1.0`). */
  tag?: string;
}

/** Install (or uninstall) the tray app. Reusable from the setup wizard. */
export async function installTray(opts: InstallTrayOptions = {}): Promise<InstallTrayResult> {
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

  // Resolve the zip: a local path (--zip) or a fresh download from the release.
  let zip: string;
  let scratch: string | null = null;
  if (opts.zip) {
    if (!existsSync(opts.zip)) {
      say(`No zip at ${opts.zip}.`);
      return { ran: false, reason: 'zip-missing' };
    }
    zip = opts.zip;
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'agentbox-tray-'));
    try {
      zip = await downloadAndVerify(opts.tag ?? DEFAULT_TAG, scratch, say);
    } catch (err) {
      rmSync(scratch, { recursive: true, force: true });
      say(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ran: false, reason: 'download-failed' };
    }
  }

  try {
    // Replace any existing copy, extract with ditto (preserves signature + notarization ticket).
    if (existsSync(APP_PATH)) rmSync(APP_PATH, { recursive: true, force: true });
    await execa('ditto', ['-x', '-k', zip, '/Applications']);
    // Belt-and-suspenders: clear any quarantine bit so Gatekeeper never blocks the download.
    await execa('xattr', ['-dr', 'com.apple.quarantine', APP_PATH]).catch(() => undefined);
    await launchTray(say);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  say(`Installed ${APP_PATH} and launched it (look for the box icon in the menu bar).`);
  return { ran: true };
}

/** True while the tray process is running. `pgrep -x` exits 1 (rejects) when nothing matches. */
async function trayRunning(): Promise<boolean> {
  return (await execa('pgrep', ['-x', APP_NAME]).catch(() => null)) !== null;
}

/**
 * Launch the freshly-installed app and confirm it actually came up. `open` returns before an
 * `LSUIElement` menu-bar app finishes registering, and right after a `ditto` extract Launch Services
 * can briefly not resolve the new bundle — so poll, then retry `open` once before giving up.
 * (Launch-at-login stays opt-in via the app's Settings; this only covers the post-install start.)
 */
async function launchTray(say: (m: string) => void): Promise<void> {
  await execa('open', [APP_PATH]).catch(() => undefined);
  for (let i = 0; i < 6; i++) {
    if (await trayRunning()) return;
    await delay(500);
  }
  await execa('open', [APP_PATH]).catch(() => undefined);
  if (!(await trayRunning())) {
    say(`The menu-bar app did not start automatically — launch it from ${APP_PATH}.`);
  }
}

/** Download `<tag>/AgentBoxTray.zip` + its `.sha256`, verify, and return the local zip path. */
async function downloadAndVerify(
  tag: string,
  dir: string,
  say: (m: string) => void,
): Promise<string> {
  const base = `${RELEASE_BASE}/${tag}`;
  const zipPath = join(dir, `${APP_NAME}.zip`);
  const shaPath = join(dir, `${APP_NAME}.zip.sha256`);

  say(`Downloading ${APP_NAME} (${tag})…`);
  await execa('curl', ['-fSL', '-o', zipPath, `${base}/${APP_NAME}.zip`]);
  await execa('curl', ['-fSL', '-o', shaPath, `${base}/${APP_NAME}.zip.sha256`]);

  // The .sha256 sidecar is `shasum` format: "<hex>  AgentBoxTray.zip".
  const expected = readFileSync(shaPath, 'utf8').trim().split(/\s+/)[0]?.toLowerCase();
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`checksum mismatch (expected ${expected ?? 'none'}, got ${actual})`);
  }
  return zipPath;
}

export const installTrayCommand = new Command('tray')
  .description('Download and install the AgentBox Tray macOS menu-bar app into /Applications')
  .option('--uninstall', 'quit and remove the menu-bar app')
  .option('--tag <tag>', 'release tag to install from (default: tray-latest)')
  .option('--zip <path>', 'install a local AgentBoxTray.zip instead of downloading')
  .action(async (opts: { uninstall?: boolean; tag?: string; zip?: string }) => {
    intro(opts.uninstall ? 'Removing AgentBox Tray…' : 'Installing AgentBox Tray…');
    const res = await installTray(opts);
    outro(res.ran ? 'Done' : `Skipped (${res.reason ?? 'nothing to do'})`);
    if (!res.ran && res.reason && res.reason !== 'not-macos') process.exitCode = 1;
  });
