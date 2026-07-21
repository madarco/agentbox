/**
 * `agentbox install app` — install the AgentBox macOS menu-bar app.
 *
 * The app is distributed separately (it's macOS-only, and keeps this cross-platform CLI small):
 * a signed+notarized `AgentBox.zip` is published to the public `madarco/agentbox` repo under the
 * moving `tray-latest` release. This command downloads it, verifies its SHA-256, unpacks it into
 * `/Applications` with `ditto` (which preserves the signature + stapled notarization ticket), and
 * launches it. macOS-only; a clean no-op elsewhere.
 *
 * Humans who prefer no CLI can instead download `AgentBox.dmg` from the same release and drag it
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
import { isNewer } from '../lib/semver-lite.js';
import { writeUpdateState } from '../lib/update-state.js';

export const APP_NAME = 'AgentBox';
export const APP_PATH = `/Applications/${APP_NAME}.app`;
/** Unified-logging subsystem the app logs under (see the app's `Diagnostics/Log.swift`). */
export const APP_BUNDLE_ID = 'com.madarco.agentbox-tray';

// The app was renamed AgentBoxTray.app → AgentBox.app but kept its bundle id. A leftover old bundle
// would collide (two bundles, one id), so remove it on install/uninstall. `agentbox app` also uses
// LEGACY_APP_NAME so status/stop/restart still see a stray pre-rename process during migration.
export const LEGACY_APP_NAME = 'AgentBoxTray';
const LEGACY_APP_PATH = `/Applications/${LEGACY_APP_NAME}.app`;

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

  // Quit any running instance (new + legacy name) so we can replace the bundle cleanly.
  await execa('pkill', ['-x', APP_NAME]).catch(() => undefined);
  await execa('pkill', ['-x', LEGACY_APP_NAME]).catch(() => undefined);

  if (opts.uninstall) {
    if (existsSync(APP_PATH)) rmSync(APP_PATH, { recursive: true, force: true });
    // Also remove a leftover pre-rename bundle.
    if (existsSync(LEGACY_APP_PATH)) rmSync(LEGACY_APP_PATH, { recursive: true, force: true });
    writeUpdateState({ traySha: undefined });
    say(`Removed ${APP_PATH}. (Launch-at-login is unregistered by the app itself.)`);
    return { ran: true };
  }

  // Resolve the zip: a local path (--zip) or a fresh download from the release.
  let zip: string;
  let sha: string | undefined;
  let scratch: string | null = null;
  if (opts.zip) {
    if (!existsSync(opts.zip)) {
      say(`No zip at ${opts.zip}.`);
      return { ran: false, reason: 'zip-missing' };
    }
    zip = opts.zip;
    sha = createHash('sha256').update(readFileSync(zip)).digest('hex');
  } else {
    scratch = mkdtempSync(join(tmpdir(), 'agentbox-tray-'));
    try {
      ({ zipPath: zip, sha } = await downloadAndVerify(opts.tag ?? DEFAULT_TAG, scratch, say));
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
    // Only now that AgentBox.app is in place, remove a leftover pre-rename bundle so the two never
    // coexist (same id). Doing it here — not earlier — means a failed download/extract can't strand
    // a user who only had the old bundle.
    if (existsSync(LEGACY_APP_PATH)) rmSync(LEGACY_APP_PATH, { recursive: true, force: true });
    // Belt-and-suspenders: clear any quarantine bit so Gatekeeper never blocks the download.
    await execa('xattr', ['-dr', 'com.apple.quarantine', APP_PATH]).catch(() => undefined);
    // Record which zip is now installed so refresh flows can compare the
    // release's ~80-byte .sha256 sidecar instead of re-downloading the app.
    writeUpdateState({ traySha: sha });
    await launchTray(say);
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }

  say(`Installed ${APP_PATH} and launched it (look for the box icon in the menu bar).`);
  return { ran: true };
}

/** Tray-app presence check shared by the update paths. */
export function trayInstalled(): boolean {
  return process.platform === 'darwin' && existsSync(APP_PATH);
}

/**
 * Fetch only the release's `AgentBox.zip.sha256` sidecar (~80 bytes) and
 * return the hex digest, or undefined on any failure. Short timeout — this
 * runs inside refresh flows and the daily background check, never on a
 * command's critical path.
 */
export async function fetchTraySidecarSha(tag: string = DEFAULT_TAG): Promise<string | undefined> {
  try {
    const { stdout } = await execa('curl', [
      '-fsSL',
      '--max-time',
      '5',
      `${RELEASE_BASE}/${tag}/${APP_NAME}.zip.sha256`,
    ]);
    return parseSidecarSha(stdout);
  } catch {
    return undefined;
  }
}

/** Parse the `shasum` sidecar format: "<hex>  AgentBox.zip". */
export function parseSidecarSha(body: string): string | undefined {
  const first = body.trim().split(/\s+/)[0]?.toLowerCase();
  return first && /^[0-9a-f]{64}$/.test(first) ? first : undefined;
}

/**
 * Fetch the release's `version.json` manifest — the published tray version, as
 * data rather than as prose in the release title. Display only: the sha
 * sidecar still decides whether to install. Releases predating the manifest
 * 404 here, so every caller must tolerate `undefined`.
 */
export async function fetchTrayLatestVersion(
  tag: string = DEFAULT_TAG,
): Promise<string | undefined> {
  try {
    const { stdout } = await execa('curl', [
      '-fsSL',
      '--max-time',
      '5',
      `${RELEASE_BASE}/${tag}/version.json`,
    ]);
    return parseVersionManifest(stdout);
  } catch {
    return undefined;
  }
}

/** Parse `version.json` → the version string, or undefined if malformed. */
export function parseVersionManifest(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { version?: unknown };
    return typeof parsed.version === 'string' && parsed.version !== '' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export interface TrayUpdateDecision {
  update: boolean;
  reason:
    | 'not-installed'
    | 'no-latest-sha'
    | 'no-stamp'
    | 'mismatch'
    | 'older-version'
    | 'up-to-date';
}

/**
 * Pure decision: reinstall only when the published sha differs from the
 * stamped one. A missing stamp with the app installed reads as update-needed
 * once (self-heals installs that predate sha stamping). An unknown latest sha
 * (offline, release missing) never triggers a download.
 */
export function decideTrayUpdate(input: {
  installed: boolean;
  stampedSha: string | undefined;
  latestSha: string | undefined;
  /** `CFBundleShortVersionString` of the app on disk — ground truth. */
  installedVersion?: string | undefined;
  /** `version` from the release's version.json. */
  latestVersion?: string | undefined;
}): TrayUpdateDecision {
  if (!input.installed) return { update: false, reason: 'not-installed' };

  // Prefer the ACTUAL versions over the sha stamp. The stamp only exists if *this*
  // CLI did the install, so a DMG-drag install (or one predating stamping) has no
  // stamp and used to read as "update available" forever, even on the newest app.
  // Comparing what is really installed against what is really published cannot lie.
  const { installedVersion, latestVersion } = input;
  if (
    installedVersion !== undefined &&
    latestVersion !== undefined &&
    isReleaseVersion(installedVersion) &&
    isReleaseVersion(latestVersion)
  ) {
    return isNewer(latestVersion, installedVersion)
      ? { update: true, reason: 'older-version' }
      : { update: false, reason: 'up-to-date' };
  }

  // Fall back to the sha stamp when a version is unreadable (no manifest on the
  // release, unparseable plist).
  if (input.latestSha === undefined) return { update: false, reason: 'no-latest-sha' };
  if (input.stampedSha === undefined) return { update: true, reason: 'no-stamp' };
  if (input.stampedSha !== input.latestSha) return { update: true, reason: 'mismatch' };
  return { update: false, reason: 'up-to-date' };
}

/** A real published version we can compare — excludes `0.0.0`/unparseable. */
function isReleaseVersion(v: string): boolean {
  const core = v.split('-', 1)[0] ?? v;
  const parts = core.split('.');
  return parts.length === 3 && parts.every((p) => /^\d+$/.test(p)) && core !== '0.0.0';
}

/**
 * The version of the app actually installed at `/Applications/AgentBox.app`, or
 * undefined when it isn't there / the plist can't be read. `plutil` handles both
 * XML and binary plists; the app is macOS-only, so this is safe to shell.
 */
export async function readInstalledTrayVersion(): Promise<string | undefined> {
  if (!trayInstalled()) return undefined;
  try {
    const { stdout } = await execa('plutil', [
      '-extract',
      'CFBundleShortVersionString',
      'raw',
      '-o',
      '-',
      join(APP_PATH, 'Contents', 'Info.plist'),
    ]);
    const v = stdout.trim();
    return v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
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

/** Download `<tag>/AgentBox.zip` + its `.sha256`, verify, and return the local zip path + sha. */
async function downloadAndVerify(
  tag: string,
  dir: string,
  say: (m: string) => void,
): Promise<{ zipPath: string; sha: string }> {
  const base = `${RELEASE_BASE}/${tag}`;
  const zipPath = join(dir, `${APP_NAME}.zip`);
  const shaPath = join(dir, `${APP_NAME}.zip.sha256`);

  say(`Downloading ${APP_NAME} (${tag})…`);
  await execa('curl', ['-fSL', '-o', zipPath, `${base}/${APP_NAME}.zip`]);
  await execa('curl', ['-fSL', '-o', shaPath, `${base}/${APP_NAME}.zip.sha256`]);

  const expected = parseSidecarSha(readFileSync(shaPath, 'utf8'));
  const actual = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
  if (!expected || expected !== actual) {
    throw new Error(`checksum mismatch (expected ${expected ?? 'none'}, got ${actual})`);
  }
  return { zipPath, sha: actual };
}

export const installAppCommand = new Command('app')
  .description('Download and install the AgentBox macOS menu-bar app into /Applications')
  .option('--uninstall', 'quit and remove the menu-bar app')
  .option('--tag <tag>', 'release tag to install from (default: tray-latest)')
  .option('--zip <path>', 'install a local AgentBox.zip instead of downloading')
  .action(async (opts: { uninstall?: boolean; tag?: string; zip?: string }) => {
    intro(opts.uninstall ? 'Removing the AgentBox app…' : 'Installing the AgentBox app…');
    const res = await installTray(opts);
    outro(res.ran ? 'Done' : `Skipped (${res.reason ?? 'nothing to do'})`);
    if (!res.ran && res.reason && res.reason !== 'not-macos') process.exitCode = 1;
  });
