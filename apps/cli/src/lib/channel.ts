/**
 * Release channels: `stable` (the default) and `nightly` (pre-release builds cut
 * from the `nightly` branch so testers can exercise a big feature before it
 * ships). Full design in docs/nightly-channel-plan.md.
 *
 * Two rules carry the whole thing:
 *
 * 1. **Nightly means "the newest build, prerelease or not"** — a nightly user
 *    polls BOTH dist-tags and takes whichever version is greater. Since a
 *    nightly is named for the release it precedes (`0.28.0-nightly.<stamp>`),
 *    semver hands us the priority for free: `0.28.0` outranks every nightly
 *    before it, so a stable release reaches nightly testers with no second
 *    publish under the `nightly` tag. Stable users only ever see `latest` and
 *    keep paying exactly one probe per component.
 *
 * 2. **Membership is sticky once joined.** Deriving the channel from the running
 *    version (a `-nightly.` suffix means nightly) is what makes
 *    `npm i -g @madarco/agentbox@nightly` self-sustaining with no config step.
 *    But rule 1 eventually hands a tester a *stable* build with no suffix, which
 *    would derive `stable` on the next launch and silently undo the opt-in — so
 *    the resolved channel gets persisted to `update.channel`.
 */

import {
  GLOBAL_CONFIG_FILE,
  loadEffectiveConfig,
  parseUserConfig,
  setConfigValue,
} from '@agentbox/config';
import { readFile } from 'node:fs/promises';
import { compareSemver } from './semver-lite.js';
import { AGENTBOX_VERSION } from '../version.js';

export type UpdateChannel = 'stable' | 'nightly';

/** What `update.channel` may hold. `auto` defers to the running build. */
export type ChannelSetting = 'auto' | UpdateChannel;

/**
 * The prerelease marker that makes a build a nightly. Matched as a substring of
 * the prerelease part rather than parsed, so `0.28.0-nightly.202607251430`
 * classifies without this module needing to know the stamp format.
 */
const NIGHTLY_MARKER = '-nightly.';

export const NPM_PACKAGE = '@madarco/agentbox';
export const STABLE_DIST_TAG = 'latest';
export const NIGHTLY_DIST_TAG = 'nightly';
export const STABLE_TRAY_TAG = 'tray-latest';
export const NIGHTLY_TRAY_TAG = 'tray-nightly';

/** The channel a version string belongs to, by its own shape. */
export function channelOfVersion(version: string): UpdateChannel {
  return version.includes(NIGHTLY_MARKER) ? 'nightly' : 'stable';
}

/** True for a version that carries a prerelease suffix of any kind. */
export function isPrerelease(version: string): boolean {
  const core = version.split('+', 1)[0] ?? version;
  return core.includes('-');
}

/**
 * npm dist-tags to poll, most-authoritative last. Nightly includes `latest`
 * because a shipped release outranks the nightlies that preceded it (rule 1).
 */
export function npmDistTags(channel: UpdateChannel): string[] {
  return channel === 'nightly' ? [STABLE_DIST_TAG, NIGHTLY_DIST_TAG] : [STABLE_DIST_TAG];
}

/** Tray release tags to poll. Same rule as {@link npmDistTags}. */
export function trayReleaseTags(channel: UpdateChannel): string[] {
  return channel === 'nightly' ? [STABLE_TRAY_TAG, NIGHTLY_TRAY_TAG] : [STABLE_TRAY_TAG];
}

export interface TaggedVersion {
  tag: string;
  version: string;
}

/**
 * The greatest candidate by semver, carrying the tag it came from — callers need
 * to know WHERE the winner lives (`install app` downloads from that tag), not
 * just that one exists.
 *
 * Candidates that failed to fetch (`version: undefined`) or aren't comparable
 * are skipped. Ties keep the earlier candidate, so `npmDistTags`' ordering makes
 * `latest` win a tie against `nightly` — the same version published under both
 * tags should read as stable.
 */
export function bestOf(
  candidates: { tag: string; version?: string | undefined }[],
): TaggedVersion | null {
  let best: TaggedVersion | null = null;
  for (const c of candidates) {
    if (c.version === undefined) continue;
    if (best === null) {
      // Guard the first candidate too: an uncomparable string (a dev sentinel, a
      // proxy's error page) must not become the winner by arriving first.
      if (compareSemver(c.version, c.version) === null) continue;
      best = { tag: c.tag, version: c.version };
      continue;
    }
    if (compareSemver(c.version, best.version) === 1) best = { tag: c.tag, version: c.version };
  }
  return best;
}

/**
 * The `update.channel` setting, or `auto` when unset/unreadable.
 *
 * Mirrors `updateCheckEnabled()`'s fallback: the layered load throws for reasons
 * unrelated to this key (a project config carrying keys from a provider plugin
 * the stock registry doesn't know), and that must not silently flip a nightly
 * tester back to stable — so fall back to the global file alone.
 */
export async function channelSetting(): Promise<ChannelSetting> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.update.channel;
  } catch {
    try {
      const raw = await readFile(GLOBAL_CONFIG_FILE, 'utf8');
      return parseUserConfig(raw, GLOBAL_CONFIG_FILE).update?.channel ?? 'auto';
    } catch {
      return 'auto';
    }
  }
}

/**
 * The channel decision, pure. An explicit setting wins; `auto` falls back to the
 * running build's shape.
 *
 * Split out from {@link resolveChannel} so it can be unit-tested: the config read
 * resolves `GLOBAL_CONFIG_FILE` at import time from the real `$HOME`, and
 * apps/cli tests have no HOME isolation.
 */
export function effectiveChannel(setting: ChannelSetting, version: string): UpdateChannel {
  return setting === 'auto' ? channelOfVersion(version) : setting;
}

/** The effective channel for this process. */
export async function resolveChannel(version: string = AGENTBOX_VERSION): Promise<UpdateChannel> {
  return effectiveChannel(await channelSetting(), version);
}

/**
 * Pin the channel in the global config so it survives a version that no longer
 * carries the marker (rule 2). Best-effort: failing to record membership must
 * never abort an update the user asked for.
 */
export async function persistChannel(channel: UpdateChannel): Promise<boolean> {
  try {
    await setConfigValue('global', 'update.channel', channel, process.cwd());
    return true;
  } catch {
    return false;
  }
}
