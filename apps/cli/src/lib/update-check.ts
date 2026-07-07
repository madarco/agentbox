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
import { fetchTraySidecarSha, trayInstalled } from '../commands/install-tray.js';
import { isNewer } from './semver-lite.js';
import {
  readUpdateState,
  remoteCheckFresh,
  writeUpdateState,
  type UpdateState,
} from './update-state.js';

const PKG = '@madarco/agentbox';
const REGISTRY_URL = `https://registry.npmjs.org/${PKG}/latest`;

/**
 * The nudge (and the registry check feeding it) only makes sense for an
 * installed release build: a dev checkout reports `0.0.0-dev`, and npx always
 * resolves latest anyway. A globally-installed bin invoked directly from the
 * shell carries no npm user-agent and classifies as `direct` — that's the
 * common case, so `direct` with a real version stays eligible.
 */
export function nudgeEligible(method: ExecMethod, version: string): boolean {
  return version !== '0.0.0-dev' && method !== 'npx';
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

async function fetchNpmLatest(): Promise<string | undefined> {
  try {
    const res = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' ? body.version : undefined;
  } catch {
    return undefined;
  }
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
    if (await updateCheckEnabled()) {
      [npmLatest, trayLatestSha] = await Promise.all([
        nudgeEligible(method, AGENTBOX_VERSION) ? fetchNpmLatest() : Promise.resolve(undefined),
        trayInstalled() ? fetchTraySidecarSha() : Promise.resolve(undefined),
      ]);
    }
    // Stamp checkedAt even when disabled or offline — the daily gate must
    // throttle regardless, or every command re-schedules this probe. Merge
    // with the previous cache so a partial probe (one fetch failed) doesn't
    // drop the other value cached earlier.
    const prev = readUpdateState().remoteCheck;
    npmLatest ??= prev?.npmLatest;
    trayLatestSha ??= prev?.trayLatestSha;
    writeUpdateState({
      remoteCheck: {
        checkedAt: new Date().toISOString(),
        ...(npmLatest !== undefined ? { npmLatest } : {}),
        ...(trayLatestSha !== undefined ? { trayLatestSha } : {}),
      },
    });
  };
  return run().catch(() => undefined);
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
  return `a newer agentbox (${latest as string}) is available — run \`agentbox self-update\``;
}
