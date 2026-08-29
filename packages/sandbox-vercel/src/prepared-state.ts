/**
 * Persisted record of what `agentbox prepare --provider vercel` has built.
 * Lives at `~/.agentbox/vercel-prepared.json` so the auto-prepare gate
 * (`ensureVercelBaseSnapshot()`) and `backend.provision` can resolve the base
 * snapshot to boot every box from.
 *
 * Two tiers are recorded here, both Vercel snapshots: the agentless `base`
 * (AL2023 + deps + agentbox-ctl + agent-browser, baked from `provision.sh`), and
 * one `variants` entry per agent set, derived by booting the base and running
 * just that agent's install recipe.
 *
 * Unlike hetzner, a Vercel snapshot carries NO name, label or tag — the SDK's
 * `createSnapshot` takes only `{sessionId, expiration}`. This file is therefore
 * the ONLY record of which snapshot is which, which is why the destroy and
 * checkpoint-remove guards derive their protected set from it.
 *
 * Schema history:
 *   1 — `base` only.
 *   2 — `variants` added: one record per agent set, so baking a `--agents codex`
 *       snapshot no longer invalidates the claude one. `base` keeps its schema-1
 *       meaning (the agentless base) and is mirrored into `variants['']`. The
 *       bump is deliberate rather than a bare optional field: an older CLI would
 *       otherwise boot every box from the base while silently ignoring the
 *       variants the user baked. A schema bump makes it treat the file as
 *       unreadable and re-bake — wrong-but-safe rather than silently wrong.
 */

import {
  claudeInstallFingerprint,
  computeContextManifest,
  computeContextSha256,
  readPreparedStateRaw,
  writePreparedStateRaw,
  preparedStatePathFor,
  type FileManifest,
} from '@agentbox/sandbox-core';
import { UserFacingError } from '@agentbox/core';
import { findStagedCliRuntimeRoot, resolveRuntimeAssets } from './runtime-assets.js';

const SCHEMA = 2 as const;

export interface PreparedVercelBase {
  /** Vercel snapshot id (opaque). The thing `Sandbox.create({ source }) ` boots from. */
  snapshotId: string;
  /** Deterministic SHA-256 of the prepare build context (provision.sh + assets). */
  contextSha256?: string;
  /**
   * Per-file digests of that context (relpath → sha256), so a later `stale`
   * verdict can name the files that changed. Optional: bases baked before
   * manifests existed simply lack it.
   */
  files?: FileManifest;
  /** CLI version that produced this snapshot (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of bake completion. */
  createdAt: string;
}

export interface PreparedVercelState {
  schema: typeof SCHEMA;
  /**
   * The AGENTLESS base, and only ever that — a variant bake leaves it alone.
   * Provider-generic readers outside this package (the freshness surface, bake
   * sharing, control-box custody adoption) reach straight for
   * `base.contextSha256`, and they all assume it describes the agentless build
   * context. Use {@link preparedEntryFor} to ask about any specific variant,
   * including the base itself.
   */
  base?: PreparedVercelBase;
  /**
   * One record per agent set, keyed by `agentSetArg(agents)` (`''` = the
   * agentless base). Without this the single `base` slot means baking a codex
   * snapshot invalidates the claude one.
   */
  variants?: Record<string, PreparedVercelBase>;
}

/**
 * The record for one variant (`''` = agentless base), falling back to `base`
 * for state written before variants existed.
 */
export function preparedEntryFor(
  state: PreparedVercelState | null,
  variant = '',
): PreparedVercelBase | undefined {
  return state?.variants?.[variant] ?? (variant === '' ? state?.base : undefined);
}

/**
 * Every snapshot id this machine knows to be SHARED — the base and each baked
 * variant. Boxes boot from these, so nothing that deletes a box's own snapshot
 * may ever delete one of them.
 */
export function sharedSnapshotIds(state: PreparedVercelState | null): Set<string> {
  const ids = new Set<string>();
  if (state?.base?.snapshotId) ids.add(state.base.snapshotId);
  for (const v of Object.values(state?.variants ?? {})) {
    if (v.snapshotId) ids.add(v.snapshotId);
  }
  return ids;
}

export function preparedStatePath(): string {
  return preparedStatePathFor('vercel');
}

export function readPreparedState(): PreparedVercelState {
  const raw = readPreparedStateRaw('vercel');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedVercelState>;
  if ((parsed as { schema?: unknown }).schema === 1) {
    // Lossless: a v1 file has exactly one bake and it is the base, so seed the
    // variants map from it rather than forcing a re-bake. That base predates the
    // agentless provision.sh and still carries all three agents, but its
    // contextSha256 no longer matches, so the freshness surface reports it stale
    // and the next prepare replaces it. Until then the user's boxes keep booting
    // a working snapshot instead of hard-failing on "no base found".
    const v1 = parsed as Partial<PreparedVercelState>;
    return { schema: SCHEMA, ...(v1.base ? { base: v1.base, variants: { '': v1.base } } : {}) };
  }
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return {
    schema: SCHEMA,
    base: parsed.base,
    ...(parsed.variants ? { variants: parsed.variants } : {}),
  };
}

export function writePreparedState(state: PreparedVercelState): void {
  writePreparedStateRaw('vercel', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedVercelState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT build-context fingerprint for the vercel base snapshot
 * (the SHA over every file `prepare` would `writeFiles` into the builder
 * sandbox). Side-effect-free — never builds. Returns `undefined` when the
 * runtime assets can't be resolved (dev tree without `pnpm -w build`) so
 * the CLI can degrade to "can't tell, don't nag".
 *
 * Used by `evaluateBaseFreshness` to compare against the stored value in
 * `vercel-prepared.json.base.contextSha256`. Must produce a byte-identical
 * hash to the one `prepare` writes — both go through the same
 * `resolveRuntimeAssets` + `computeContextSha256` chain.
 */
export async function currentVercelBaseFingerprintLive(
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

/**
 * First-use gate. If no base snapshot is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider vercel`. Called by `backend.provision`
 * (indirectly via the snapshot resolution) and usable by the CLI.
 */
export function ensureVercelBaseSnapshot(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no Vercel base snapshot found.\n' +
      'Run `agentbox prepare --provider vercel` first — Vercel cannot build images ' +
      'from a Dockerfile, so the base snapshot is a one-time prerequisite for cloud boxes.',
  );
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
export async function currentVercelBaseFileHashes(): Promise<FileManifest | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    return (await computeContextManifest(assets.map((a) => ({ rel: a.name, abs: a.localPath }))))
      .files;
  } catch {
    return undefined;
  }
}
