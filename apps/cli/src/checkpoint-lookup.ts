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
import { agentSetArg, normalizeAgentSet } from '@agentbox/sandbox-core';
import {
  computeDockerContextFingerprint,
  imageExists,
  readPreparedDockerState,
  resolveCheckpoint,
} from '@agentbox/sandbox-docker';
import {
  baseFreshnessFromFingerprints,
  currentCloudBaseFingerprint,
  probeCloudCheckpoint,
  resolveCloudCheckpoint,
  type BaseStatus,
} from '@agentbox/sandbox-cloud';
import {
  cloudBackendForProvider,
  currentCloudBaseFingerprintLive,
} from './provider/cloud-backend.js';

/**
 * The checkpoint was captured from a box built for a different agent set.
 *
 * Orthogonal to `state`: a checkpoint can be perfectly fresh and still be the
 * wrong agent, so this rides alongside rather than folding into `stale` — which
 * would make an up-to-date checkpoint look outdated and invite the wizard to
 * offer discarding it.
 */
export interface CheckpointAgentMismatch {
  /** Agent set recorded in the manifest (never empty — absent is not a mismatch). */
  captured: string[];
  /** Agent set the new box is being created for. */
  requested: string[];
}

export type CheckpointStatus =
  /** No manifest, a dead/expired cloud snapshot, or an orphaned Docker image — not bootable. */
  | { state: 'missing' }
  /** Bootable, but its base image/snapshot is older than the current one (or unverifiable). */
  | { state: 'stale'; reason: string; agentMismatch?: CheckpointAgentMismatch }
  /** Bootable and captured against the current base. */
  | { state: 'fresh'; agentMismatch?: CheckpointAgentMismatch };

/**
 * Compare a manifest's recorded agent set against the one being created for.
 *
 * `undefined` (not a mismatch) whenever the answer is UNKNOWN: a manifest with
 * no `agents` predates the field, and a create with no agent set means "all".
 * Treating either as a mismatch would warn on every pre-existing checkpoint.
 *
 * Order-insensitive: the set is normalised the same way variant lookup keys are
 * (`agentSetArg(normalizeAgentSet(...))`), so ['codex','claude'] matches
 * ['claude','codex'] instead of reading as a difference.
 */
export function agentSetMismatch(
  captured: readonly string[] | undefined,
  requested: readonly string[] | undefined,
): CheckpointAgentMismatch | undefined {
  if (!captured || captured.length === 0) return undefined;
  if (!requested || requested.length === 0) return undefined;
  const a = normalizeAgentSet(captured);
  const b = normalizeAgentSet(requested);
  if (agentSetArg(a) === agentSetArg(b)) return undefined;
  return { captured: [...a], requested: [...b] };
}

/** One-line, actionable description of a mismatch. */
export function describeAgentMismatch(m: CheckpointAgentMismatch): string {
  return (
    `checkpoint was captured from a ${m.captured.join(',')} box but this box is for ` +
    `${m.requested.join(',')} — it will boot with ${m.captured.join(',')} baked in, and ` +
    `${m.requested.join(',')} installed on top at create`
  );
}

function short(sha: string): string {
  return sha.slice(0, 12);
}

async function evaluateDockerCheckpoint(
  projectRoot: string,
  ref: string,
  agents?: readonly string[],
): Promise<CheckpointStatus> {
  const head = await resolveCheckpoint(projectRoot, ref);
  if (!head) return { state: 'missing' };
  // The checkpoint *image* is the docker-run base. A manifest with no backing
  // image (pruned out-of-band) can't boot — treat as missing so the wizard
  // falls through to a fresh setup rather than offering "use it anyway".
  if (!(await imageExists(head.manifest.image))) return { state: 'missing' };

  const mismatch = agentSetMismatch(head.manifest.agents, agents);
  const fp = head.manifest.baseFingerprint;
  if (head.manifest.schema === 2 || !fp) {
    return {
      state: 'stale',
      reason: 'captured before checkpoint versioning; base image unverifiable',
      ...(mismatch ? { agentMismatch: mismatch } : {}),
    };
  }
  const current =
    readPreparedDockerState()?.base?.contextSha256 ??
    (await computeDockerContextFingerprint())?.contextSha256;
  if (current && fp !== current) {
    return {
      state: 'stale',
      reason: `base image updated since capture (captured ${short(fp)}, current ${short(current)})`,
      ...(mismatch ? { agentMismatch: mismatch } : {}),
    };
  }
  return { state: 'fresh', ...(mismatch ? { agentMismatch: mismatch } : {}) };
}

async function evaluateCloudCheckpoint(
  provider: ProviderName,
  projectRoot: string,
  ref: string,
  agents?: readonly string[],
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

  const mismatch = agentSetMismatch(found.manifest.agents, agents);
  const fp = found.manifest.baseFingerprint;
  if (found.manifest.schema < 2 || !fp) {
    return {
      state: 'stale',
      reason: 'captured before checkpoint versioning; base snapshot unverifiable',
      ...(mismatch ? { agentMismatch: mismatch } : {}),
    };
  }
  const current = currentCloudBaseFingerprint(provider);
  if (current && fp !== current) {
    return {
      state: 'stale',
      reason: `base snapshot updated since capture (captured ${short(fp)}, current ${short(current)})`,
      ...(mismatch ? { agentMismatch: mismatch } : {}),
    };
  }
  return { state: 'fresh', ...(mismatch ? { agentMismatch: mismatch } : {}) };
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
  agents?: readonly string[],
): Promise<CheckpointStatus> {
  if (provider === 'docker') return evaluateDockerCheckpoint(projectRoot, ref, agents);
  return evaluateCloudCheckpoint(provider, projectRoot, ref, agents);
}

/**
 * Warn when `ref` was captured from a box built for a different agent set.
 *
 * Lives at REF RESOLUTION rather than in the setup wizard because `codex` and
 * `opencode` never run the wizard — they read `box.defaultCheckpoint<Provider>`
 * straight into `checkpointRef`. A wizard-only warning would therefore miss the
 * exact case this exists for: a default captured from a claude box silently
 * applying to every codex box on that provider, with no user signal at all.
 *
 * Reads the manifest only — deliberately NOT `evaluateCheckpoint`, which probes
 * cloud snapshot liveness over the network. A warning must not add a round-trip
 * to every create.
 *
 * Silent whenever the answer is unknown or the checkpoint is unreadable: this is
 * advisory, and it must never be the reason a create fails or slows down.
 */
export async function warnCheckpointAgentMismatch(
  provider: ProviderName,
  projectRoot: string,
  ref: string | undefined,
  agents: readonly string[] | undefined,
  warn: (message: string) => void,
): Promise<void> {
  if (!ref) return;
  try {
    const captured =
      provider === 'docker'
        ? (await resolveCheckpoint(projectRoot, ref))?.manifest.agents
        : (await resolveCloudCheckpoint(projectRoot, provider, ref))?.manifest.agents;
    const mismatch = agentSetMismatch(captured, agents);
    if (mismatch) warn(describeAgentMismatch(mismatch));
  } catch {
    // Advisory only — never fail a create over a warning.
  }
}

export type { BaseStatus };

/**
 * Decide whether the provider's base image / snapshot is still up to date
 * with the CURRENT runtime context. The CLI re-prompts at `create`/`claude`
 * time so a stale base (a CLI upgrade that altered any baked file) doesn't
 * silently boot incompatible boxes on an old snapshot. Docker self-heals via
 * `ensureImage` and is always `fresh` here. Cloud providers compare the stored
 * `<provider>-prepared.json.base.contextSha256` (via
 * `currentCloudBaseFingerprint`) against a freshly-computed one (via
 * `currentCloudBaseFingerprintLive`), which the provider package builds the
 * same way `prepare` does — so both values are byte-identical when nothing
 * has changed. The compare itself lives in `baseFreshnessFromFingerprints`
 * (sandbox-cloud) so the hub reports the identical state + reason string.
 */
export async function evaluateBaseFreshness(
  provider: ProviderName,
  claudeInstall?: 'native' | 'npm',
): Promise<BaseStatus> {
  if (provider === 'docker') {
    // Docker used to be hardcoded `fresh` here, on the grounds that it self-heals
    // via `ensureImage`. It does — but only at create time, and `self-update` no
    // longer deletes the image to force the issue, so a stale base could otherwise
    // sit unmentioned until the next create surprised you with a multi-minute
    // build. Report the real state, the same one the hub/app show.
    const { evaluateDockerBaseFreshness } = await import('@agentbox/sandbox-docker');
    return await evaluateDockerBaseFreshness({ claudeInstall });
  }
  const stored = currentCloudBaseFingerprint(provider);
  if (!stored) return { state: 'unprepared' };
  const current = await currentCloudBaseFingerprintLive(provider, claudeInstall).catch(
    () => undefined,
  );
  return baseFreshnessFromFingerprints(stored, current);
}
