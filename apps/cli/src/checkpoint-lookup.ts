/**
 * Provider-aware checkpoint evaluation used by the wizard. The default
 * checkpoint name lives in a single config field (`box.defaultCheckpoint`),
 * but the actual artifact may exist for Docker, for a cloud backend, both, or
 * neither — and even when it exists it may be *stale* (captured against a base
 * image/snapshot that has since been rebuilt) or *orphaned* (its underlying
 * Docker image / cloud snapshot is gone).
 *
 * `evaluateCheckpoint` collapses all of that into three states so the wizard
 * can decide whether to silently skip setup (`fresh`), re-prompt the user to
 * recreate it (`stale`), or fall through to normal setup (`missing`). Without
 * this, a stale checkpoint would announce "starting from checkpoint …; skipping
 * setup" and then quietly rebuild the base image while booting from the old
 * layers — the exact confusion this module exists to prevent.
 */

import type { ProviderName } from '@agentbox/core';
import {
  computeDockerContextFingerprint,
  imageExists,
  readPreparedDockerState,
  resolveCheckpoint,
} from '@agentbox/sandbox-docker';
import {
  currentCloudBaseFingerprint,
  probeCloudCheckpoint,
  resolveCloudCheckpoint,
} from '@agentbox/sandbox-cloud';
import { cloudBackendForProvider, currentCloudBaseFingerprintLive } from './provider/cloud-backend.js';

export type CheckpointStatus =
  /** No manifest, a dead/expired cloud snapshot, or an orphaned Docker image — not bootable. */
  | { state: 'missing' }
  /** Bootable, but its base image/snapshot is older than the current one (or unverifiable). */
  | { state: 'stale'; reason: string }
  /** Bootable and captured against the current base. */
  | { state: 'fresh' };

function short(sha: string): string {
  return sha.slice(0, 12);
}

async function evaluateDockerCheckpoint(
  projectRoot: string,
  ref: string,
): Promise<CheckpointStatus> {
  const head = await resolveCheckpoint(projectRoot, ref);
  if (!head) return { state: 'missing' };
  // The checkpoint *image* is the docker-run base. A manifest with no backing
  // image (pruned out-of-band) can't boot — treat as missing so the wizard
  // falls through to a fresh setup rather than offering "use it anyway".
  if (!(await imageExists(head.manifest.image))) return { state: 'missing' };

  const fp = head.manifest.baseFingerprint;
  if (head.manifest.schema === 2 || !fp) {
    return {
      state: 'stale',
      reason: 'captured before checkpoint versioning; base image unverifiable',
    };
  }
  const current =
    readPreparedDockerState()?.base?.contextSha256 ??
    (await computeDockerContextFingerprint())?.contextSha256;
  if (current && fp !== current) {
    return {
      state: 'stale',
      reason: `base image updated since capture (captured ${short(fp)}, current ${short(current)})`,
    };
  }
  return { state: 'fresh' };
}

async function evaluateCloudCheckpoint(
  provider: ProviderName,
  projectRoot: string,
  ref: string,
): Promise<CheckpointStatus> {
  const found = await resolveCloudCheckpoint(projectRoot, provider, ref);
  if (!found) return { state: 'missing' };
  // Confirm the provider snapshot is still bootable. A gone snapshot is pruned
  // here so the next read sees nothing. A probe failure (network / creds) is
  // treated as "assume live": never strand a usable checkpoint on a transient
  // error.
  try {
    const backend = await cloudBackendForProvider(provider);
    if (backend) {
      const { live } = await probeCloudCheckpoint(backend, projectRoot, ref);
      if (!live) return { state: 'missing' };
    }
  } catch {
    // assume live
  }

  const fp = found.manifest.baseFingerprint;
  if (found.manifest.schema < 2 || !fp) {
    return {
      state: 'stale',
      reason: 'captured before checkpoint versioning; base snapshot unverifiable',
    };
  }
  const current = currentCloudBaseFingerprint(provider);
  if (current && fp !== current) {
    return {
      state: 'stale',
      reason: `base snapshot updated since capture (captured ${short(fp)}, current ${short(current)})`,
    };
  }
  return { state: 'fresh' };
}

/**
 * Classify `ref` for the active provider. `docker` resolves against the local
 * checkpoint store + image engine; cloud backends resolve the manifest, probe
 * snapshot liveness, then compare base fingerprints.
 */
export async function evaluateCheckpoint(
  provider: ProviderName,
  projectRoot: string,
  ref: string,
): Promise<CheckpointStatus> {
  if (provider === 'docker') return evaluateDockerCheckpoint(projectRoot, ref);
  return evaluateCloudCheckpoint(provider, projectRoot, ref);
}

/**
 * Cloud base-image / base-snapshot freshness, derived purely from the
 * `contextSha256` of the baked runtime files. The CLI re-prompts at
 * `create`/`claude` time so a stale base (a CLI upgrade that altered any
 * baked file) doesn't silently boot incompatible boxes on an old snapshot.
 *
 * **Checksum-only.** CLI version strings stored alongside the fingerprint
 * are informational and MUST NOT influence the decision: a CLI bump that
 * doesn't change any baked file produces an identical hash → `fresh`.
 */
export type BaseStatus =
  /** No prepared base on disk — the ensure-gate inside `provision` raises the hard error. */
  | { state: 'unprepared' }
  /**
   * Can't compute the live fingerprint (e.g. a dev tree with no built ctl
   * bundle). Inert: callers must not prompt for a rebuild they can't verify.
   */
  | { state: 'unknown' }
  /** Stored fingerprint differs from current — the baked runtime is out of date. */
  | { state: 'stale'; reason: string }
  /** Stored fingerprint matches current. */
  | { state: 'fresh' };

/**
 * Decide whether the provider's base image / snapshot is still up to date
 * with the CURRENT runtime context. Docker self-heals via `ensureImage` and
 * is always `fresh` here. Cloud providers compare the stored
 * `<provider>-prepared.json.base.contextSha256` (via
 * `currentCloudBaseFingerprint`) against a freshly-computed one (via
 * `currentCloudBaseFingerprintLive`), which the provider package builds the
 * same way `prepare` does — so both values are byte-identical when nothing
 * has changed.
 */
export async function evaluateBaseFreshness(provider: ProviderName): Promise<BaseStatus> {
  if (provider === 'docker') return { state: 'fresh' };
  const stored = currentCloudBaseFingerprint(provider);
  if (!stored) return { state: 'unprepared' };
  const current = await currentCloudBaseFingerprintLive(provider).catch(() => undefined);
  if (!current) return { state: 'unknown' };
  if (stored !== current) {
    return {
      state: 'stale',
      reason: `baked runtime differs (base ${short(stored)}, current ${short(current)})`,
    };
  }
  return { state: 'fresh' };
}
