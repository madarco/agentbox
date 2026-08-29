/**
 * Docker provider's `~/.agentbox/docker-prepared.json` reader/writer + the
 * build-context fingerprint that drives base-image invalidation.
 *
 * The fingerprint is a SHA-256 over every file `docker build` would COPY
 * into the image — Dockerfile + scripts + baked config files. Two CLIs
 * with identical staged runtime trees produce the same hash; a one-byte
 * edit to any baked asset flips it, which is the signal `ensureImage()`
 * uses to rebuild instead of reusing the cached image.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeContextManifest,
  DOCKER_CONTEXT_FILE_MAP,
  readCliStamp,
  readPreparedStateRaw,
  resolveContextFilesFrom,
  writePreparedStateRaw,
  type ContextFile,
  type FileManifest,
  type PreparedBaseSnapshot,
} from '@agentbox/sandbox-core';
import { BUILD_CONTEXT_DIR, DEFAULT_BOX_IMAGE, DOCKERFILE_PATH } from './image.js';

const SCHEMA = 1 as const;

/**
 * One prepared record per image VARIANT, keyed by its agent-set arg (`''` for
 * the agentless base, `'claude'`, `'claude,codex'`, …).
 *
 * Without this there is a single `base` slot, so building the codex image
 * overwrites the note that the claude image was prepared — and the next
 * `agentbox claude` rebuilds an image that is already sitting on disk. Anyone
 * alternating agents rebuilds every time.
 *
 * `base` is kept as "the most recently prepared image" so existing readers
 * (prepare --status, the freshness nag, custody adoption) are unaffected.
 */
export type PreparedDockerState = PreparedBaseSnapshot<string, never> & {
  variants?: Record<string, NonNullable<PreparedBaseSnapshot<string, never>['base']>>;
};

/**
 * Resolve every fingerprint input to an absolute path. The canonical file
 * list lives in `@agentbox/sandbox-core` (DOCKER_CONTEXT_FILE_MAP) so the
 * daytona provider can hash the same inputs without depending on this
 * package. Two layouts are tried in order, mirroring `resolveDockerBuild()`
 * in `image.ts`:
 *   1. Build context dir (staged runtime / env override).
 *   2. Sandbox-docker package root (dev fallback).
 *
 * Returns `null` when *any* required file is missing — callers treat that
 * as "can't fingerprint" and skip the cache-hit shortcut (always rebuild).
 */
export function resolveContextFiles(opts: { contextDir?: string } = {}): ContextFile[] | null {
  const ctx = opts.contextDir ?? BUILD_CONTEXT_DIR;
  const here = dirname(fileURLToPath(import.meta.url));
  // sandbox-docker's package root = parent of src/ or parent of dist/.
  const packageRoot = resolve(here, '..');
  return resolveContextFilesFrom(DOCKER_CONTEXT_FILE_MAP, {
    contextDir: ctx,
    devRoot: packageRoot,
  });
}

export interface ResolvedFingerprint {
  contextSha256: string;
  /** Files that fed the hash (in canonical sorted order). */
  files: ContextFile[];
  /** Per-file digests, recorded at bake time so a later `stale` can be explained. */
  manifest: FileManifest;
}

export async function computeDockerContextFingerprint(
  opts: {
    contextDir?: string;
  } = {},
): Promise<ResolvedFingerprint | null> {
  const files = resolveContextFiles(opts);
  if (!files) return null;
  const m = await computeContextManifest(files);
  return { contextSha256: m.contextSha256, files, manifest: m.files };
}

/**
 * The per-file digests of the CURRENT docker build context, for diffing against
 * a baked manifest. Returns undefined when the context can't be resolved (a dev
 * tree with no staged runtime) — the caller then has nothing to compare and must
 * not claim a diff.
 */
export async function currentDockerBaseFileHashes(): Promise<FileManifest | undefined> {
  try {
    const files = resolveContextFiles();
    if (!files) return undefined;
    return (await computeContextManifest(files)).files;
  } catch {
    return undefined;
  }
}

export function readPreparedDockerState(): PreparedDockerState | null {
  const raw = readPreparedStateRaw('docker');
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<PreparedDockerState>;
  if (parsed.schema !== SCHEMA) return null;
  return {
    schema: SCHEMA,
    base: parsed.base,
    ...(parsed.variants ? { variants: parsed.variants } : {}),
  };
}

export function writePreparedDockerState(opts: {
  imageRef?: string;
  contextSha256: string;
  /** Per-file digests of the context this image was built from, when known. */
  files?: FileManifest;
  /** Agent-set key this record is for (`''` = the agentless base). */
  variant?: string;
}): void {
  const stamp = readCliStamp();
  const entry = {
    imageRef: opts.imageRef ?? DEFAULT_BOX_IMAGE,
    contextSha256: opts.contextSha256,
    cliVersion: stamp.cliVersion,
    cliCommit: stamp.cliCommit,
    createdAt: new Date().toISOString(),
    ...(opts.files ? { files: opts.files } : {}),
  };
  // Merge, never replace: each variant keeps its own record so switching
  // agents doesn't invalidate the one you built last time.
  const existing = readPreparedDockerState();
  const state: PreparedDockerState = {
    schema: SCHEMA,
    base: entry,
    variants: { ...existing?.variants, [opts.variant ?? '']: entry },
  };
  writePreparedStateRaw('docker', state);
}

/**
 * The fingerprint stamped for one variant (`''` = the agentless base).
 *
 * Reads the variant's own record, falling back to `base` for records written
 * before variants existed. Callers must NOT read `base` directly: it is
 * overwritten with whatever was prepared most recently, so after an
 * `agentbox claude` bake it holds the claude-variant hash and comparing the
 * agentless fingerprint against it reports a spurious `stale`.
 */
export function preparedShaFor(state: PreparedDockerState | null, variant = ''): string | null {
  return state?.variants?.[variant]?.contextSha256 ?? state?.base?.contextSha256 ?? null;
}

/**
 * Convenience for `ensureImage` and `prepare` — true when the stamped
 * fingerprint matches.
 *
 * Checks this variant's own record first, then falls back to `base` so a
 * record written before variants existed still counts as a hit.
 */
export function preparedMatches(
  state: PreparedDockerState | null,
  current: string,
  variant?: string,
): boolean {
  return preparedShaFor(state, variant ?? '') === current;
}

/** Re-export so callers don't reach into image.ts just for the Dockerfile path. */
export { DOCKERFILE_PATH };
