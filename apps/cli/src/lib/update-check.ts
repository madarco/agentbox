/**
 * Daily-throttled update check + "newer version available" nudge.
 *
 * Network discipline: normal CLI calls never hit the network. At most once
 * per 24h an eligible interactive command fires ONE background check (npm
 * registry `latest` + the tray zip's ~80-byte sha256 sidecar), un-awaited,
 * short-timeout, all errors swallowed, result cached in
 * `~/.agentbox/update-state.json`. The nudge itself always prints from the
 * cache — typically the previous day's result.
 */

import { readFile } from 'node:fs/promises';
import { GLOBAL_CONFIG_FILE, loadEffectiveConfig, parseUserConfig } from '@agentbox/config';
import { detectExecutionMethod, type ExecMethod } from '../exec-method.js';
import { AGENTBOX_VERSION } from '../version.js';
import {
  bestTrayRelease,
  fetchTrayLatestVersion,
  fetchTraySidecarSha,
  trayInstalled,
} from '../commands/install-app.js';
import {
  NPM_PACKAGE,
  bestOf,
  isPrerelease,
  npmDistTags,
  resolveChannel,
  type UpdateChannel,
} from './channel.js';
import { isNewer } from './semver-lite.js';
import {
  readUpdateState,
  remoteCheckFresh,
  writeUpdateState,
  type RemoteCheck,
  type UpdateState,
} from './update-state.js';

const PKG = NPM_PACKAGE;
const registryUrl = (distTag: string) => `https://registry.npmjs.org/${PKG}/${distTag}`;

/**
 * The nudge (and the registry check feeding it) only makes sense when
 * `agentbox self-update` can actually act: an npm/pnpm global install with a
 * real release version. A dev checkout reports `0.0.0-dev`, npx always
 * resolves latest anyway, and `direct` (a checkout run via symlink) has no
 * global install to update — nudging those would point at a self-update that
 * skips. `detectExecutionMethod` resolves the bin symlink, so a global
 * install invoked straight from the shell classifies as npm/pnpm.
 */
export function nudgeEligible(method: ExecMethod, version: string): boolean {
  return version !== '0.0.0-dev' && (method === 'npm' || method === 'pnpm');
}

/**
 * `update.check` config gate. The layered load can throw for reasons
 * unrelated to this key (e.g. a project config carrying keys from a provider
 * plugin the stock registry doesn't know) — that must not override an
 * explicit global opt-out, so fall back to reading the global file alone.
 */
export async function updateCheckEnabled(): Promise<boolean> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.update.check;
  } catch {
    try {
      const raw = await readFile(GLOBAL_CONFIG_FILE, 'utf8');
      return parseUserConfig(raw, GLOBAL_CONFIG_FILE).update?.check ?? true;
    } catch (err) {
      // No global config at all → the default (enabled). A global file that
      // exists but doesn't parse → stay quiet rather than add noise.
      return (err as NodeJS.ErrnoException).code === 'ENOENT';
    }
  }
}

async function fetchDistTag(distTag: string): Promise<string | undefined> {
  try {
    const res = await fetch(registryUrl(distTag), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The newest published CLI on `channel`. Stable probes one dist-tag; nightly
 * probes both and takes the greater, so a shipped release supersedes the
 * nightlies that preceded it without needing a second publish under `nightly`.
 */
export async function fetchNpmBest(channel: UpdateChannel): Promise<string | undefined> {
  const tags = npmDistTags(channel);
  const found = await Promise.all(
    tags.map(async (tag) => ({ tag, version: await fetchDistTag(tag) })),
  );
  return bestOf(found)?.version;
}

/**
 * Same shape for the tray. `bestTrayRelease` returns null for stable (and when
 * nothing comparable came back), in which case this falls back to the stable
 * tag's sha — exactly the behavior that existed before channels.
 */
interface TrayProbe {
  sha?: string | undefined;
  version?: string | undefined;
}

async function fetchTrayBest(channel: UpdateChannel): Promise<TrayProbe> {
  const winner = await bestTrayRelease(channel);
  if (!winner) {
    const [sha, version] = await Promise.all([fetchTraySidecarSha(), fetchTrayLatestVersion()]);
    return { sha, version };
  }
  return { sha: await fetchTraySidecarSha(winner.tag), version: winner.version };
}

/**
 * Merge a probe's results over the previous cache, so a partial probe (one
 * fetch failed) doesn't drop what the other cached earlier.
 *
 * The tray sha and the tray version describe the SAME release, so they must
 * travel together. Carrying a stale version forward alongside a fresh sha
 * would name the previous release in the update prompt while installing the
 * new one — so when the sha moves and the manifest didn't come back (a 404 on
 * a release predating the manifest, or a transient failure), the version is
 * dropped rather than inherited. The prompt then just omits the version.
 */
export function mergeRemoteCheck(
  fetched: {
    npmLatest?: string | undefined;
    trayLatestSha?: string | undefined;
    trayLatestVersion?: string | undefined;
  },
  prev: RemoteCheck | undefined,
): Omit<RemoteCheck, 'checkedAt'> {
  const npmLatest = fetched.npmLatest ?? prev?.npmLatest;
  const trayLatestSha = fetched.trayLatestSha ?? prev?.trayLatestSha;

  const shaMoved =
    fetched.trayLatestSha !== undefined && fetched.trayLatestSha !== prev?.trayLatestSha;
  const trayLatestVersion =
    fetched.trayLatestVersion ?? (shaMoved ? undefined : prev?.trayLatestVersion);

  return {
    ...(npmLatest !== undefined ? { npmLatest } : {}),
    ...(trayLatestSha !== undefined ? { trayLatestSha } : {}),
    ...(trayLatestVersion !== undefined ? { trayLatestVersion } : {}),
  };
}

/**
 * Kick off the daily remote check if the cache is stale. Returns immediately;
 * the fetches run in the background and persist their result when they land.
 * Callers must NOT await the returned promise on the command's critical path.
 */
export function maybeStartRemoteCheck(): Promise<void> | null {
  const state = readUpdateState();
  if (remoteCheckFresh(state)) return null;

  const method = detectExecutionMethod({
    userAgent: process.env.npm_config_user_agent,
    argv1: process.argv[1],
  });

  const run = async (): Promise<void> => {
    let npmLatest: string | undefined;
    let trayLatestSha: string | undefined;
    let trayLatestVersion: string | undefined;
    if (await updateCheckEnabled()) {
      const channel = await resolveChannel();
      const [npm, tray] = await Promise.all([
        nudgeEligible(method, AGENTBOX_VERSION)
          ? fetchNpmBest(channel)
          : Promise.resolve(undefined),
        trayInstalled() ? fetchTrayBest(channel) : Promise.resolve<TrayProbe>({}),
      ]);
      npmLatest = npm;
      trayLatestSha = tray.sha;
      trayLatestVersion = tray.version;
    }
    // Stamp checkedAt even when disabled or offline — the daily gate must
    // throttle regardless, or every command re-schedules this probe.
    writeUpdateState({
      remoteCheck: {
        checkedAt: new Date().toISOString(),
        ...mergeRemoteCheck(
          { npmLatest, trayLatestSha, trayLatestVersion },
          readUpdateState().remoteCheck,
        ),
      },
    });
  };
  return run().catch(() => undefined);
}

/**
 * The menu-bar app nudge, or null. Never prompts and never blocks — a stale app
 * is worth one line after the command, not an interruption in the middle of one.
 *
 * `installedVersion` is read off the installed bundle, so this is decided on what
 * is really installed vs what is really published — NOT on the sha stamp, which
 * only exists when this CLI did the install and therefore reported a phantom
 * update forever on a DMG-drag install.
 */
export function trayNudgeMessage(
  state: UpdateState,
  installedVersion: string | undefined,
): string | null {
  const latest = state.remoteCheck?.trayLatestVersion;
  if (!latest || !installedVersion) return null;
  if (!isNewer(latest, installedVersion)) return null;
  return `a newer AgentBox app (${latest}, you have ${installedVersion}) is available — run \`agentbox install app\``;
}

/** The nudge line to print after the command, or null. Reads the cache only. */
export function nudgeMessage(
  state: UpdateState,
  method: ExecMethod,
  version: string = AGENTBOX_VERSION,
): string | null {
  if (!nudgeEligible(method, version)) return null;
  const latest = state.remoteCheck?.npmLatest;
  if (!isNewer(latest, version)) return null;
  // On the nightly channel the newest build is regularly a plain release that
  // supersedes the nightlies before it. `0.28.0` offered to someone running
  // `0.28.0-nightly.5` reads like a downgrade without this hint.
  const crossover = isPrerelease(version) && !isPrerelease(latest as string);
  const what = crossover ? `${latest as string}, the stable release` : (latest as string);
  return `a newer agentbox (${what}) is available — run \`agentbox self-update\``;
}
