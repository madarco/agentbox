/**
 * Persisted record of what `agentbox prepare --provider hetzner` has built.
 * Lives at `~/.agentbox/hetzner-prepared.json` so the auto-prepare gate
 * (`ensureHetznerBaseSnapshot()`) and runtime image resolution can see it.
 *
 * Two tiers are recorded here, both provider-side snapshots: the agentless
 * `base` (Ubuntu + deps + agentbox-ctl + agent-browser, baked from
 * `install-box.sh`), and one `variants` entry per agent set, derived by booting
 * the base and running just that agent's install recipe.
 *
 * The per-project snapshot tier is NOT a separate registry: it's the existing
 * `agentbox checkpoint create --set-default` + `box.defaultCheckpointHetzner`
 * flow (see `docs/cloud-create-flow.md` §"base vs project snapshot"), and
 * auto-capture at the end of setup is driven by the `/agentbox-setup` skill
 * (`agentbox-ctl checkpoint --set-default`), cross-provider. So there's no
 * `projects[<hash>]` map here.
 *
 * Schema versioned so future shape changes can migrate.
 */

import {
  computeContextManifest,
  computeContextSha256,
  preparedStatePathFor,
  readPreparedStateRaw,
  writePreparedStateRaw,
  type FileManifest,
} from '@agentbox/sandbox-core';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

/**
 * Schema history:
 *   1 — `base.imageId`, `base.description`, `base.createdAt`,
 *       `base.installScriptSha256?`
 *   2 — `base.installScriptSha256` → `base.contextSha256` (now covers every
 *       asset we scp'd in, not just the install script); `base.cliVersion`
 *       and `base.cliCommit?` added so we can warn when an old snapshot
 *       predates the running CLI.
 *   3 — `variants` added: one record per agent set, so baking a `--agents
 *       codex` snapshot no longer invalidates the claude one. `base` keeps its
 *       schema-2 meaning (the agentless base) and is mirrored into
 *       `variants['']`. The bump is deliberate rather than a bare optional
 *       field: an older CLI would otherwise boot every box from the agentless
 *       base while silently ignoring the variants the user baked. A schema bump
 *       makes it treat the file as unreadable and re-bake — wrong-but-safe
 *       rather than silently wrong.
 *
 * Read-time migration is lossy in one direction: a schema-1 file is lifted
 * to schema 2 by *renaming* `installScriptSha256` to `contextSha256`. The
 * hash doesn't change but the meaning narrows (install script only → full
 * asset list), so the next `agentbox prepare --provider hetzner` run will
 * recompute and overwrite. A legacy `projects` key (an early, never-wired
 * per-project tier) is simply ignored — removing the field doesn't break
 * reads, so no schema bump is needed.
 */
const SCHEMA = 3 as const;

export interface PreparedBaseSnapshot {
  /** Hetzner image id (numeric — opaque, but stable across `getImage` calls). */
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
  /**
   * Per-file digests of that context (relpath → sha256), so a later `stale`
   * verdict can name the files that changed. Optional: snapshots baked before
   * manifests existed simply lack it.
   */
  files?: FileManifest;
  /** CLI version that produced this snapshot (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
}

export interface PreparedHetznerState {
  schema: typeof SCHEMA;
  /**
   * The AGENTLESS base, and only ever that — a variant bake leaves it alone.
   * Provider-generic readers outside this package (the freshness surface, bake
   * sharing, control-box custody adoption) reach straight for
   * `base.contextSha256`, and they all assume it describes the agentless build
   * context. Use {@link preparedEntryFor} to ask about any specific variant,
   * including the base itself.
   */
  base?: PreparedBaseSnapshot;
  /**
   * One record per agent set, keyed by `agentSetArg(agents)` (`''` = the
   * agentless base). Without this the single `base` slot means baking a codex
   * snapshot invalidates the claude one, and anyone alternating agents re-bakes
   * a VPS every time.
   */
  variants?: Record<string, PreparedBaseSnapshot>;
}

/**
 * The record for one variant (`''` = agentless base), falling back to `base`
 * for state written before variants existed.
 */
export function preparedEntryFor(
  state: PreparedHetznerState | null,
  variant = '',
): PreparedBaseSnapshot | undefined {
  return state?.variants?.[variant] ?? (variant === '' ? state?.base : undefined);
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
  return preparedStatePathFor('hetzner');
}

export function readPreparedState(): PreparedHetznerState {
  const raw = readPreparedStateRaw('hetzner');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedHetznerState> | LegacyV1State;
  if ((parsed as { schema?: unknown }).schema === 1) {
    const v1 = parsed as LegacyV1State;
    return migrateFromV1(v1);
  }
  if ((parsed as { schema?: unknown }).schema === 2) {
    // Lossless: a v2 file has exactly one bake and it is the agentless base,
    // so seed the variants map from it rather than forcing a re-bake.
    const v2 = parsed as Partial<PreparedHetznerState>;
    return {
      schema: SCHEMA,
      ...(v2.base ? { base: v2.base, variants: { '': v2.base } } : {}),
    };
  }
  if (parsed.schema !== SCHEMA) {
    // Unknown schema: don't crash, just refuse to read — the file will be
    // overwritten on the next successful prepare.
    return { schema: SCHEMA };
  }
  return {
    schema: SCHEMA,
    base: parsed.base,
    variants: parsed.variants,
  };
}

function migrateFromV1(v1: LegacyV1State): PreparedHetznerState {
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
    ...(base ? { base, variants: { '': base } } : {}),
  };
}

export function writePreparedState(state: PreparedHetznerState): void {
  writePreparedStateRaw('hetzner', state);
}

/**
 * Convenience helper: update one field of the state without forcing callers
 * to read/merge/write themselves.
 */
export function updatePreparedState(mutate: (s: PreparedHetznerState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT build-context fingerprint for the hetzner base snapshot
 * (the SHA over every file `prepare` would scp into the prepare VPS).
 * Side-effect-free — never builds. Returns `undefined` when the runtime
 * assets can't be resolved (dev tree without `pnpm -w build`) so the CLI
 * can degrade to "can't tell, don't nag".
 *
 * Used by `evaluateBaseFreshness` to compare against the stored value in
 * `hetzner-prepared.json.base.contextSha256`. Must produce a byte-identical
 * hash to the one `prepare` writes — both go through the same
 * `resolveRuntimeAssets` + `computeContextSha256` chain.
 */
export async function currentHetznerBaseFingerprintLive(): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    // The AGENTLESS base: no agent setting folds in, because it installs no
    // agent. Per-agent artifacts get their own `variantFingerprint`.
    return await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath })));
  } catch {
    return undefined;
  }
}

/**
 * Per-file digests of the CURRENT runtime assets, for diffing against the
 * manifest stored at bake time so a `stale` verdict can name the changed files.
 * Same asset list the fingerprint uses — each provider resolves its own, so this
 * must live beside it rather than in a shared helper.
 *
 * `undefined` when the assets can't be resolved (dev tree without a build): the
 * caller then has nothing to compare and must not claim a diff.
 */
export async function currentHetznerBaseFileHashes(): Promise<FileManifest | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    return (await computeContextManifest(assets.map((a) => ({ rel: a.name, abs: a.localPath }))))
      .files;
  } catch {
    return undefined;
  }
}
