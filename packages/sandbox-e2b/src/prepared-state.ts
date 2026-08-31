/**
 * Persisted record of what `agentbox prepare --provider e2b` has built.
 * Lives at `~/.agentbox/e2b-prepared.json` so the auto-prepare gate
 * (`ensureE2bBaseTemplate()`) and `backend.provision` can resolve the base
 * template every box boots from.
 *
 * Two tiers, both E2B templates: the agentless `base` (Debian + agentbox-ctl +
 * the box runtime) and one `variants` entry per agent set, built declaratively
 * on top of it with `Template().fromTemplate(base)`. Templates on E2B are
 * id+tag-addressed reusable resources, so unlike Vercel snapshots we don't worry
 * about per-box eviction; each template is reused for every create.
 *
 * Schema history:
 *   1 — single `base` template.
 *   2 — `variants` added: one record per agent set, so building the codex
 *       template doesn't invalidate the claude one. `base` keeps its schema-1
 *       meaning (the agentless base) and is mirrored into `variants['']`;
 *       provider-generic readers outside this package reach straight for
 *       `base.contextSha256` and assume exactly that.
 */

import {
  agentInstallFingerprint,
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

export interface PreparedE2bBase {
  /** Opaque E2B template id (e.g. `tmpl_xxxx` or `name:tag`). Sandbox.create({ template }) boots from this. */
  templateId: string;
  /** Human-friendly template name passed to Template.build (e.g. `agentbox-base:latest`). */
  templateName?: string;
  /** Deterministic SHA-256 of the build context (build script + assets). */
  contextSha256?: string;
  /**
   * Per-file digests of that context (relpath → sha256), so a later `stale`
   * verdict can name the files that changed. Optional: bases baked before
   * manifests existed simply lack it.
   */
  files?: FileManifest;
  /** Normalized `cpu-memory` GB size the template was baked with (absent = default resources). */
  size?: string;
  /** CLI version that produced this template (informational). */
  cliVersion?: string;
  /** Git short SHA of the CLI build (informational). */
  cliCommit?: string;
  /** ISO timestamp of bake completion. */
  createdAt: string;
}

export interface PreparedE2bState {
  schema: typeof SCHEMA;
  /**
   * The shared AGENTLESS base template, and only ever that — a variant build
   * leaves it alone. Absent until first `agentbox prepare`.
   */
  base?: PreparedE2bBase;
  /**
   * One record per agent set, keyed by `agentSetArg(agents)` (`''` = the
   * agentless base). Without this the single `base` slot means building a codex
   * template invalidates the claude one, and anyone alternating agents rebuilds
   * every time.
   */
  variants?: Record<string, PreparedE2bBase>;
}

/**
 * The record for one variant (`''` = agentless base), falling back to `base`
 * for state written before variants existed.
 */
export function preparedEntryFor(
  state: PreparedE2bState | null,
  variant = '',
): PreparedE2bBase | undefined {
  return state?.variants?.[variant] ?? (variant === '' ? state?.base : undefined);
}

export function preparedStatePath(): string {
  return preparedStatePathFor('e2b');
}

export function readPreparedState(): PreparedE2bState {
  const raw = readPreparedStateRaw('e2b');
  if (raw === null || typeof raw !== 'object') return { schema: SCHEMA };
  const parsed = raw as Partial<PreparedE2bState>;
  if ((parsed as { schema?: unknown }).schema === 1) {
    // Lossless: a v1 file has exactly one build and it is the base, so seed the
    // variants map from it rather than forcing a rebuild.
    const v1 = parsed;
    return {
      schema: SCHEMA,
      ...(v1.base ? { base: v1.base, variants: { '': v1.base } } : {}),
    };
  }
  if (parsed.schema !== SCHEMA) {
    // Unknown/missing schema: refuse to read — the next prepare overwrites it.
    return { schema: SCHEMA };
  }
  return { schema: SCHEMA, base: parsed.base, variants: parsed.variants };
}

export function writePreparedState(state: PreparedE2bState): void {
  writePreparedStateRaw('e2b', state);
}

/** Update one field of the state without forcing callers to read/merge/write. */
export function updatePreparedState(mutate: (s: PreparedE2bState) => void): void {
  const s = readPreparedState();
  mutate(s);
  writePreparedState(s);
}

/**
 * Compute the CURRENT build-context fingerprint for the e2b base template
 * (the SHA over every file `prepare` would copy into the Template build).
 * Side-effect-free — never builds. Returns `undefined` when the runtime
 * assets can't be resolved (dev tree without `pnpm -w build`) so the CLI
 * can degrade to "can't tell, don't nag" rather than flag a false stale.
 *
 * Used by `evaluateBaseFreshness` to compare against the stored value in
 * `e2b-prepared.json.base.contextSha256`. Must produce a byte-identical
 * hash to the one `prepare` writes — both go through the same
 * `resolveRuntimeAssets` + `computeContextSha256` chain.
 */
export async function currentE2bBaseFingerprintLive(
  agentInstall: 'native' | 'npm' = 'native',
): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    // Fold in agentInstall exactly as `prepare` does — otherwise an npm-baked
    // base never matches the stored (npm-folded) fingerprint.
    return agentInstallFingerprint(
      await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath }))),
      agentInstall,
    );
  } catch {
    return undefined;
  }
}

/**
 * First-use gate. If no base template is recorded, throw an actionable error
 * pointing at `agentbox prepare --provider e2b`. Called by `backend.provision`
 * (so `create` / `claude` trip it but `prepare` itself does not — same shape
 * as the hetzner/vercel gates).
 */
export function ensureE2bBaseTemplate(): void {
  const state = readPreparedState();
  if (state.base !== undefined) return;
  throw new UserFacingError(
    'no E2B base template found.\n' +
      'Run `agentbox prepare --provider e2b` first — it bakes a custom template ' +
      'with the agentbox runtime (agentbox-ctl, vscode user, claude/codex/opencode, tmux) ' +
      'so per-box `create` boots ready in seconds.',
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
export async function currentE2bBaseFileHashes(): Promise<FileManifest | undefined> {
  try {
    const assets = resolveRuntimeAssets({ cliRuntimeRoot: findStagedCliRuntimeRoot() });
    return (await computeContextManifest(assets.map((a) => ({ rel: a.name, abs: a.localPath }))))
      .files;
  } catch {
    return undefined;
  }
}
