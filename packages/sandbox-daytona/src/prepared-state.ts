/**
 * Daytona provider's `~/.agentbox/daytona-prepared.json` reader/writer +
 * build-context fingerprinting for the org-scoped base snapshot.
 *
 * The daytona prepare bakes the docker `Dockerfile.box` plus a daytona-
 * specific `custom-system-CLAUDE.md` overlay. The fingerprint covers both
 * — same canonical file map as the docker provider for the dockerfile
 * inputs, plus one extra entry for the daytona overlay.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaytonaSandboxClass } from '@agentbox/config';
import {
  claudeInstallFingerprint,
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

/** Provider-specific extras baked into the daytona snapshot. `size` is the
 *  normalized `cpu-memory-disk` spec the snapshot was created with (absent =
 *  a default-resource bake). `class` is the sandbox class it was baked as —
 *  absent means a snapshot from before classes existed, i.e. a container.
 *  A snapshot's class is immutable and cannot make a sandbox of the other
 *  class, so this is what `provision` records on the box record. */
export interface DaytonaPreparedExtras {
  size?: string;
  class?: DaytonaSandboxClass;
}

export type PreparedDaytonaState = PreparedBaseSnapshot<string, DaytonaPreparedExtras>;

/**
 * Resolve every file that influences the daytona base snapshot: the docker
 * build context (shared map from sandbox-core) plus the daytona-specific
 * CLAUDE.md overlay added by `Image.addLocalFile` in `prepare.ts`.
 *
 * Returns `null` if any file is missing — callers degrade to "always
 * rebuild" rather than stamp a misleading fingerprint.
 */
export function resolveDaytonaContextFiles(): ContextFile[] | null {
  const docker = resolveDockerContextFilesForDaytona();
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

/**
 * Just the DOCKER half of the context — no daytona overlay, no seed-schema salt.
 *
 * This is the exact file set (and therefore the exact sha) that CI hashes when
 * it publishes `ghcr.io/madarco/agentbox/box:sha-<...>`, so it — and only it —
 * can name the published image. The linux-vm bake needs that ref because Daytona
 * builds a VM snapshot only from a prebuilt registry image, never a Dockerfile.
 */
export function resolveDockerContextFilesForDaytona(): ContextFile[] | null {
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
  return resolveContextFilesFrom(DOCKER_CONTEXT_FILE_MAP, {
    contextDir: ctx.context,
    devRoot: existsSync(dockerPackageRoot) ? dockerPackageRoot : packageRoot,
  });
}

/**
 * The raw docker build-context sha — the tag of the published GHCR box image.
 *
 * Deliberately NOT folded with `claudeInstallFingerprint` (unlike the daytona
 * snapshot fingerprint): CI builds the image with no `--build-arg`, so only the
 * `native` variant is ever published. An npm-install bake has no GHCR tag at
 * all, which is why the VM path falls back to the container class for it.
 */
export async function computeDockerBaseSha(): Promise<string | null> {
  const files = resolveDockerContextFilesForDaytona();
  if (!files) return null;
  return computeContextSha256(files);
}

export interface DaytonaFingerprint {
  contextSha256: string;
  files: ContextFile[];
}

/**
 * Bumped when the daytona seed-bake BUILD LOGIC changes in a way the
 * context-file fingerprint can't see (the files are unchanged but the emitted
 * Dockerfile steps differ). `relctx-1`: switched from absolute `addLocalFile`
 * COPYs (which silently never landed) to relative `dockerfileCommands` COPYs.
 * Folding it into the fingerprint forces existing snapshots to re-bake once.
 */
const DAYTONA_SEED_SCHEMA = 'relctx-1';

export async function computeDaytonaContextFingerprint(): Promise<DaytonaFingerprint | null> {
  const files = resolveDaytonaContextFiles();
  if (!files) return null;
  const rawSha = await computeContextSha256(files);
  const contextSha256 = createHash('sha256')
    .update(`${rawSha}\0daytona-seed=${DAYTONA_SEED_SCHEMA}`)
    .digest('hex');
  return { contextSha256, files };
}

/**
 * Compute the CURRENT build-context fingerprint for the daytona base snapshot.
 * Side-effect-free wrapper around `computeDaytonaContextFingerprint` that
 * returns just the SHA (or `undefined` when assets can't be resolved). Used
 * by the CLI's `evaluateBaseFreshness` to compare against the stored
 * `daytona-prepared.json.base.contextSha256`.
 */
export async function currentDaytonaBaseFingerprintLive(
  claudeInstall: 'native' | 'npm' = 'native',
): Promise<string | undefined> {
  try {
    const fp = await computeDaytonaContextFingerprint();
    if (!fp?.contextSha256) return undefined;
    // Fold in claudeInstall exactly as `prepare` does — otherwise an npm-baked
    // base never matches the stored (npm-folded) fingerprint.
    return claudeInstallFingerprint(fp.contextSha256, claudeInstall);
  } catch {
    return undefined;
  }
}

export function readPreparedDaytonaState(): PreparedDaytonaState | null {
  const raw = readPreparedStateRaw('daytona');
  if (raw === null || typeof raw !== 'object') return null;
  const parsed = raw as Partial<PreparedDaytonaState>;
  if (parsed.schema !== SCHEMA) return null;
  return { schema: SCHEMA, base: parsed.base, extras: parsed.extras };
}

export function writePreparedDaytonaState(opts: {
  snapshotName: string;
  contextSha256: string;
  /** Normalized `cpu-memory-disk` size the snapshot was baked with (absent = default). */
  size?: string;
  /** Sandbox class the snapshot was baked as. Absent on pre-class bakes = container. */
  class?: DaytonaSandboxClass;
}): void {
  const stamp = readCliStamp();
  const extras: DaytonaPreparedExtras = {
    ...(opts.size ? { size: opts.size } : {}),
    ...(opts.class ? { class: opts.class } : {}),
  };
  const state: PreparedDaytonaState = {
    schema: SCHEMA,
    base: {
      imageRef: opts.snapshotName,
      contextSha256: opts.contextSha256,
      cliVersion: stamp.cliVersion,
      cliCommit: stamp.cliCommit,
      createdAt: new Date().toISOString(),
    },
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
  writePreparedStateRaw('daytona', state);
}

/**
 * A prepared snapshot matches when its build-context fingerprint, its baked
 * size AND its baked class all equal the requested ones. Neither size nor class
 * is folded into `contextSha256` — the live freshness check
 * (`currentDaytonaBaseFingerprintLive`) compares fingerprints only and takes no
 * config, so folding either in would make every sized/classed bake read as
 * "context drifted".
 *
 * An absent baked class means a snapshot from before classes existed, which was
 * necessarily a container — so it only matches a container request.
 */
export function preparedMatches(
  state: PreparedDaytonaState | null,
  current: string,
  size?: string,
  sandboxClass?: DaytonaSandboxClass,
): boolean {
  if (state?.base?.contextSha256 !== current) return false;
  if ((state?.extras?.size ?? undefined) !== (size ?? undefined)) return false;
  if (sandboxClass === undefined) return true;
  return (state?.extras?.class ?? 'container') === sandboxClass;
}
