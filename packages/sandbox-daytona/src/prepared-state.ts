/**
 * Daytona provider's `~/.agentbox/daytona-prepared.json` reader/writer +
 * build-context fingerprinting for the org-scoped base snapshot.
 *
 * The daytona prepare bakes the docker `Dockerfile.box` plus a daytona-
 * specific `custom-system-CLAUDE.md` overlay. The fingerprint covers both
 * — same canonical file map as the docker provider for the dockerfile
 * inputs, plus one extra entry for the daytona overlay.
 */

import { existsSync } from 'node:fs';
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
import { resolveDaytonaCustomClaudeMd, resolveDockerfileContext } from './dockerfile-context.js';

const SCHEMA = 1 as const;

export type PreparedDaytonaState = PreparedBaseSnapshot<string, never>;

/**
 * Resolve every file that influences the daytona base snapshot: the docker
 * build context (shared map from sandbox-core) plus the daytona-specific
 * CLAUDE.md overlay added by `Image.addLocalFile` in `prepare.ts`.
 *
 * Returns `null` if any file is missing — callers degrade to "always
 * rebuild" rather than stamp a misleading fingerprint.
 */
export function resolveDaytonaContextFiles(): ContextFile[] | null {
  const ctx = resolveDockerfileContext();
  if (!ctx) return null;
  // sandbox-daytona's package root = parent of src/ or parent of dist/.
  // Mirrors the `resolve(here, '..', '..', '..')` walk in dockerfile-context.ts.
  const here = dirname(fileURLToPath(import.meta.url));
  const packageRoot = resolve(here, '..');
  const monorepoRoot = resolve(here, '..', '..', '..');
  // Docker's dev fallback is anchored at sandbox-docker's root, not
  // sandbox-daytona's, so we pass the monorepo root and prefix the dev
  // paths to walk into packages/sandbox-docker/.
  //
  // Simpler: just point devRoot at sandbox-docker's package root when it
  // exists (legacy monorepo layout).
  const dockerPackageRoot = resolve(monorepoRoot, 'packages', 'sandbox-docker');
  const docker = resolveContextFilesFrom(DOCKER_CONTEXT_FILE_MAP, {
    contextDir: ctx.context,
    devRoot: existsSync(dockerPackageRoot) ? dockerPackageRoot : packageRoot,
  });
  if (!docker) return null;
  const overlay = resolveDaytonaCustomClaudeMd();
  if (!overlay) return null;
  return [
    ...docker,
    // Daytona-specific overlay: separate logical name so a docker/daytona
    // CLAUDE.md drift produces different fingerprints (the daytona snapshot
    // contains both files in distinct locations).
    { rel: 'daytona/custom-system-CLAUDE.md', abs: overlay },
  ];
}

export interface DaytonaFingerprint {
  contextSha256: string;
  files: ContextFile[];
}

export async function computeDaytonaContextFingerprint(): Promise<DaytonaFingerprint | null> {
  const files = resolveDaytonaContextFiles();
  if (!files) return null;
  return { contextSha256: await computeContextSha256(files), files };
}

/**
 * Compute the CURRENT build-context fingerprint for the daytona base snapshot.
 * Side-effect-free wrapper around `computeDaytonaContextFingerprint` that
 * returns just the SHA (or `undefined` when assets can't be resolved). Used
 * by the CLI's `evaluateBaseFreshness` to compare against the stored
 * `daytona-prepared.json.base.contextSha256`.
 */
export async function currentDaytonaBaseFingerprintLive(): Promise<string | undefined> {
  try {
    const fp = await computeDaytonaContextFingerprint();
    return fp?.contextSha256;
  } catch {
    return undefined;
  }
}

export function readPreparedDaytonaState(): PreparedDaytonaState | null {
  const raw = readPreparedStateRaw('daytona');
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<PreparedDaytonaState>;
  if (parsed.schema !== SCHEMA) return null;
  return { schema: SCHEMA, base: parsed.base };
}

export function writePreparedDaytonaState(opts: {
  snapshotName: string;
  contextSha256: string;
}): void {
  const stamp = readCliStamp();
  const state: PreparedDaytonaState = {
    schema: SCHEMA,
    base: {
      imageRef: opts.snapshotName,
      contextSha256: opts.contextSha256,
      cliVersion: stamp.cliVersion,
      cliCommit: stamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
  };
  writePreparedStateRaw('daytona', state);
}

export function preparedMatches(
  state: PreparedDaytonaState | null,
  current: string,
): boolean {
  return state?.base?.contextSha256 === current;
}
