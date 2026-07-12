/**
 * Persisted record of what `agentbox prepare --provider aws` has baked. Lives at
 * `~/.agentbox/aws-prepared.json` so the auto-prepare gate (`ensureAwsBaseAmi()`)
 * and runtime image resolution can see it.
 *
 * Only the shared `base` AMI is recorded: Ubuntu + deps + agentbox-ctl + agents
 * + agent-browser, baked once from `install-box.sh`. The per-project tier is not
 * a separate registry — it's `agentbox checkpoint create --set-default` +
 * `box.defaultCheckpointAws` (see `docs/cloud-create-flow.md`).
 *
 * Two fields differ from the hetzner/digitalocean shape:
 *   - `amiId` is a **string** (`ami-0abc…`), not a numeric image id.
 *   - `region` is recorded, because **AMIs are region-scoped**. An AMI baked in
 *     `us-east-1` cannot boot an instance in `eu-central-1`; the backend fails
 *     loud on a mismatch rather than letting EC2 return a confusing
 *     `InvalidAMIID.NotFound`.
 */

import {
  claudeInstallFingerprint,
  computeContextSha256,
  preparedStatePathFor,
  readPreparedStateRaw,
  writePreparedStateRaw,
} from '@agentbox/sandbox-core';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

const SCHEMA = 1 as const;

export interface PreparedBaseAmi {
  /** EC2 AMI id (`ami-…`). */
  amiId: string;
  /** Region the AMI lives in. AMIs do not cross regions without an explicit CopyImage. */
  region: string;
  /** User-facing AMI name. */
  description: string;
  /** ISO timestamp of bake completion. */
  createdAt: string;
  /** Deterministic SHA-256 over the build context (every file scp'd into the bake instance). */
  contextSha256?: string;
  /** CLI version that produced this AMI (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
}

export interface PreparedAwsState {
  schema: typeof SCHEMA;
  /** The shared base AMI. Absent until the first `agentbox prepare --provider aws`. */
  base?: PreparedBaseAmi;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('aws');
}

export function readPreparedState(): PreparedAwsState {
  const raw = readPreparedStateRaw('aws');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedAwsState>;
  if (parsed.schema !== SCHEMA) {
    // Unknown schema: don't crash, just refuse to read — the next successful
    // prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedState(state: PreparedAwsState): void {
  writePreparedStateRaw('aws', state);
}

/** Update one field without making callers read/merge/write themselves. */
export function updatePreparedState(mutate: (s: PreparedAwsState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT build-context fingerprint for the aws base AMI (the SHA
 * over every file `prepare` would scp into the bake instance). Side-effect-free
 * — never builds. Returns `undefined` when the runtime assets can't be resolved
 * (a dev tree without `pnpm -w build`), so the CLI degrades to "can't tell,
 * don't nag" rather than falsely reporting the base as stale.
 *
 * Must produce a byte-identical hash to the one `prepare` writes — both go
 * through the same `resolveRuntimeAssets` + `computeContextSha256` +
 * `claudeInstallFingerprint` chain.
 */
export async function currentAwsBaseFingerprintLive(
  claudeInstall: 'native' | 'npm' = 'native',
): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    // Fold in claudeInstall exactly as `prepare` does — otherwise an npm-baked
    // base never matches the stored (npm-folded) fingerprint.
    return claudeInstallFingerprint(
      await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
      claudeInstall,
    );
  } catch {
    return undefined;
  }
}
