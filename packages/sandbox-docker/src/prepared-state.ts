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
  computeContextSha256,
  DOCKER_CONTEXT_FILE_MAP,
  readCliStamp,
  readPreparedStateRaw,
  resolveContextFilesFrom,
  writePreparedStateRaw,
  type ContextFile,
  type PreparedBaseSnapshot,
} from '@agentbox/sandbox-core';
import { BUILD_CONTEXT_DIR, DEFAULT_BOX_IMAGE, DOCKERFILE_PATH } from './image.js';

const SCHEMA = 1 as const;

export type PreparedDockerState = PreparedBaseSnapshot<string, never>;

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
}

export async function computeDockerContextFingerprint(opts: {
  contextDir?: string;
} = {}): Promise<ResolvedFingerprint | null> {
  const files = resolveContextFiles(opts);
  if (!files) return null;
  return { contextSha256: await computeContextSha256(files), files };
}

export function readPreparedDockerState(): PreparedDockerState | null {
  const raw = readPreparedStateRaw('docker');
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<PreparedDockerState>;
  if (parsed.schema !== SCHEMA) return null;
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedDockerState(opts: {
  imageRef?: string;
  contextSha256: string;
}): void {
  const stamp = readCliStamp();
  const state: PreparedDockerState = {
    schema: SCHEMA,
    base: {
      imageRef: opts.imageRef ?? DEFAULT_BOX_IMAGE,
      contextSha256: opts.contextSha256,
      cliVersion: stamp.cliVersion,
      cliCommit: stamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
  };
  writePreparedStateRaw('docker', state);
}

/** Convenience for `ensureImage` and `prepare` — true when the stamped fingerprint matches. */
export function preparedMatches(state: PreparedDockerState | null, current: string): boolean {
  return state?.base?.contextSha256 === current;
}

/** Re-export so callers don't reach into image.ts just for the Dockerfile path. */
export { DOCKERFILE_PATH };
