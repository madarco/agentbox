/**
 * Persisted record of what `agentbox prepare --provider digitalocean` has built.
 * Lives at `~/.agentbox/digitalocean-prepared.json` so the auto-prepare gate
 * (`ensureDigitalOceanBaseSnapshot()`) and runtime image resolution can see it.
 *
 * Only the shared `base` snapshot is recorded here — built once per DigitalOcean
 * project / API token: Ubuntu + deps + agentbox-ctl + agents + agent-browser,
 * baked from `install-box.sh`.
 *
 * The per-project snapshot tier is NOT a separate registry: it's the existing
 * `agentbox checkpoint create --set-default` + `box.defaultCheckpointDigitalOcean`
 * flow (see `docs/cloud-create-flow.md` §"base vs project snapshot"), and
 * auto-capture at the end of setup is driven by the `/agentbox-setup` skill
 * (`agentbox-ctl checkpoint --set-default`), cross-provider. So there's no
 * `projects[<hash>]` map here.
 *
 * Schema versioned so future shape changes can migrate.
 */

import { claudeInstallFingerprint, computeContextSha256, preparedStatePathFor, readPreparedStateRaw, writePreparedStateRaw } from '@agentbox/sandbox-core';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

/**
 * Schema history:
 *   1 — `base.imageId`, `base.description`, `base.createdAt`,
 *       `base.installScriptSha256?`
 *   2 — `base.installScriptSha256` → `base.contextSha256` (now covers every
 *       asset we scp'd in, not just the install script); `base.cliVersion`
 *       and `base.cliCommit?` added so we can warn when an old snapshot
 *       predates the running CLI.
 *
 * Read-time migration is lossy in one direction: a schema-1 file is lifted
 * to schema 2 by *renaming* `installScriptSha256` to `contextSha256`. The
 * hash doesn't change but the meaning narrows (install script only → full
 * asset list), so the next `agentbox prepare --provider digitalocean` run will
 * recompute and overwrite. A legacy `projects` key (an early, never-wired
 * per-project tier) is simply ignored — removing the field doesn't break
 * reads, so no schema bump is needed.
 */
const SCHEMA = 2 as const;

export interface PreparedBaseSnapshot {
  /** DigitalOcean image id (numeric — opaque, but stable across `getImage` calls). */
  imageId: number;
  /** User-facing description (matches the firewall-dashboard rows). */
  description: string;
  /** ISO timestamp of bake-completion. */
  createdAt: string;
  /**
   * Deterministic SHA-256 of the build context (every file scp'd into the
   * prepare VPS). Rebuild when it changes.
   */
  contextSha256?: string;
  /** CLI version that produced this snapshot (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
}

export interface PreparedDigitalOceanState {
  schema: typeof SCHEMA;
  /** The shared base snapshot. Absent until first `agentbox prepare`. */
  base?: PreparedBaseSnapshot;
}

interface LegacyV1Base {
  imageId: number;
  description: string;
  createdAt: string;
  installScriptSha256?: string;
}

interface LegacyV1State {
  schema: 1;
  base?: LegacyV1Base;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('digitalocean');
}

export function readPreparedState(): PreparedDigitalOceanState {
  const raw = readPreparedStateRaw('digitalocean');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedDigitalOceanState> | LegacyV1State;
  if ((parsed as { schema?: unknown }).schema === 1) {
    const v1 = parsed as LegacyV1State;
    return migrateFromV1(v1);
  }
  if (parsed.schema !== SCHEMA) {
    // Unknown schema: don't crash, just refuse to read — the file will be
    // overwritten on the next successful prepare.
    return { schema: SCHEMA };
  }
  return {
    schema: SCHEMA,
    base: parsed.base,
  };
}

function migrateFromV1(v1: LegacyV1State): PreparedDigitalOceanState {
  // The v1 `installScriptSha256` covered only `install-box.sh`, not the full
  // asset list a v2 `contextSha256` represents. Lifting it forward as a
  // placeholder fingerprint means the next prepare run will mismatch and
  // rebuild — exactly what we want, since the broader hash semantics also
  // changed.
  const base: PreparedBaseSnapshot | undefined = v1.base
    ? {
        imageId: v1.base.imageId,
        description: v1.base.description,
        createdAt: v1.base.createdAt,
        contextSha256: v1.base.installScriptSha256,
      }
    : undefined;
  return {
    schema: SCHEMA,
    base,
  };
}

export function writePreparedState(state: PreparedDigitalOceanState): void {
  writePreparedStateRaw('digitalocean', state);
}

/**
 * Convenience helper: update one field of the state without forcing callers
 * to read/merge/write themselves.
 */
export function updatePreparedState(mutate: (s: PreparedDigitalOceanState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT build-context fingerprint for the digitalocean base snapshot
 * (the SHA over every file `prepare` would scp into the prepare VPS).
 * Side-effect-free — never builds. Returns `undefined` when the runtime
 * assets can't be resolved (dev tree without `pnpm -w build`) so the CLI
 * can degrade to "can't tell, don't nag".
 *
 * Used by `evaluateBaseFreshness` to compare against the stored value in
 * `digitalocean-prepared.json.base.contextSha256`. Must produce a byte-identical
 * hash to the one `prepare` writes — both go through the same
 * `resolveRuntimeAssets` + `computeContextSha256` chain.
 */
export async function currentDigitalOceanBaseFingerprintLive(
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
