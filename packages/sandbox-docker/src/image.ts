import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { claudeInstallFingerprint } from '@agentbox/sandbox-core';

export const DEFAULT_BOX_IMAGE = 'agentbox/box:dev';

/**
 * Resolve the effective `box.claudeInstall` for the current project. Docker
 * builds its image lazily at create time, so every `ensureImage` path must
 * agree on the mode or a native rebuild would clobber an npm-baked image (and
 * vice-versa). Lazy-imported to keep the module load cheap; falls back to
 * `native` if config can't be read.
 */
async function resolveClaudeInstallMode(): Promise<'native' | 'npm'> {
  try {
    const { loadEffectiveConfig } = await import('@agentbox/config');
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.box.claudeInstall;
  } catch {
    return 'native';
  }
}

/**
 * Public registry repo the box image is published to (see
 * `.github/workflows/box-image.yml`). The CLI pulls a fingerprint-tagged
 * image from here on first use instead of building locally — a multi-minute
 * build collapses to a `docker pull`. An empty registry (config override)
 * disables pulling and always builds.
 */
export const BOX_IMAGE_REGISTRY = 'ghcr.io/madarco/agentbox/box';

/**
 * The pull target for a given build-context fingerprint. The tag *is* the
 * content identity: a local staged context that matches a published build
 * has the same sha, so a pull hit can be retagged to `agentbox/box:dev` and
 * stamped into docker-prepared.json without risk of a stale image (a locally
 * edited context has a different sha, its tag 404s, and we build instead).
 */
export function registryRefForSha(sha: string, registry: string = BOX_IMAGE_REGISTRY): string {
  return `${registry}:sha-${sha.slice(0, 16)}`;
}

const here = dirname(fileURLToPath(import.meta.url));

// The Dockerfile's COPY lines reference monorepo-relative paths
// (packages/ctl/dist/bin.cjs, apps/cli/share/..., packages/sandbox-docker/scripts/*),
// so the build context must be a dir containing that tree.
//
// Resolution order:
//   0. AGENTBOX_DOCKER_CONTEXT env override (dir holding Dockerfile.box).
//   1. Staged context shipped with the bundled `agent-box` package: this
//      module is bundled into the CLI at <root>/dist, the stage step mirrors
//      the COPY tree at <root>/runtime/docker (sibling of dist/, uniform in
//      dev and when installed).
//   2. Legacy monorepo: Dockerfile.box at the sandbox-docker package root,
//      build context = monorepo root.
function resolveDockerBuild(): { dockerfile: string; context: string } {
  const override = process.env.AGENTBOX_DOCKER_CONTEXT;
  if (override && existsSync(resolve(override, 'Dockerfile.box'))) {
    return { dockerfile: resolve(override, 'Dockerfile.box'), context: override };
  }
  const staged = resolve(here, '..', 'runtime', 'docker');
  if (existsSync(resolve(staged, 'Dockerfile.box'))) {
    return { dockerfile: resolve(staged, 'Dockerfile.box'), context: staged };
  }
  // Legacy: src/ (or the unbundled package dist/) is one level under the
  // package root; the monorepo root is two more up.
  const packageRoot = resolve(here, '..');
  return {
    dockerfile: resolve(packageRoot, 'Dockerfile.box'),
    context: resolve(packageRoot, '..', '..'),
  };
}

const { dockerfile: DOCKERFILE_PATH_RESOLVED, context: BUILD_CONTEXT_DIR_RESOLVED } =
  resolveDockerBuild();
export const DOCKERFILE_PATH = DOCKERFILE_PATH_RESOLVED;
export const BUILD_CONTEXT_DIR = BUILD_CONTEXT_DIR_RESOLVED;

export async function imageExists(ref: string): Promise<boolean> {
  const result = await execa('docker', ['image', 'inspect', ref], { reject: false });
  return result.exitCode === 0;
}

/**
 * Attempt `docker pull <target>`. Returns true on success, false on any
 * failure (missing tag, offline, auth) — callers fall back to a local build.
 * Never throws. Single attempt: a missing tag is the expected "build locally"
 * signal, not a transient error worth retrying.
 */
export async function pullImage(
  target: string,
  opts: { onProgress?: (line: string) => void } = {},
): Promise<boolean> {
  const subprocess = execa('docker', ['pull', target], {
    stderr: 'pipe',
    stdout: 'pipe',
    reject: false,
  });
  if (opts.onProgress) {
    const forward = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) opts.onProgress?.(line);
      }
    };
    subprocess.stdout?.on('data', forward);
    subprocess.stderr?.on('data', forward);
  }
  const result = await subprocess;
  return result.exitCode === 0;
}

export async function tagImage(source: string, target: string): Promise<void> {
  await execa('docker', ['tag', source, target]);
}

export interface ImageInfo {
  /** Image ref (e.g. `agentbox/box:dev`). */
  ref: string;
  /** True when the engine has the image locally. */
  exists: boolean;
  /** Image size in bytes, when known. */
  sizeBytes?: number;
  /** ISO-8601 creation time, when known. */
  createdAt?: string;
}

/**
 * Read-only inspect of a Docker image. Used by `agentbox prepare` (no-args
 * status mode) to surface base-image state. Never throws — returns
 * `{ exists: false }` on any error so the status command works even when
 * the docker daemon is unreachable.
 */
export async function imageInfo(ref: string = DEFAULT_BOX_IMAGE): Promise<ImageInfo> {
  const result = await execa(
    'docker',
    ['image', 'inspect', '--format', '{{.Size}}|{{.Created}}', ref],
    { reject: false },
  );
  if (result.exitCode !== 0) return { ref, exists: false };
  const [sizeStr, createdAt] = result.stdout.trim().split('|');
  const sizeBytes = sizeStr ? Number.parseInt(sizeStr, 10) : NaN;
  return {
    ref,
    exists: true,
    sizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : undefined,
    createdAt: createdAt && createdAt.length > 0 ? createdAt : undefined,
  };
}

export interface BuildImageOptions {
  ref?: string;
  dockerfile?: string;
  contextDir?: string;
  /** `--build-arg K=V` pairs forwarded to `docker build` (e.g. AGENTBOX_CLAUDE_INSTALL). */
  buildArgs?: Record<string, string>;
  onProgress?: (line: string) => void;
}

export async function buildImage(opts: BuildImageOptions = {}): Promise<string> {
  const ref = opts.ref ?? DEFAULT_BOX_IMAGE;
  const dockerfile = opts.dockerfile ?? DOCKERFILE_PATH;
  const contextDir = opts.contextDir ?? BUILD_CONTEXT_DIR;

  // Dogfood path: when building from inside an agentbox (docker-in-docker),
  // the default bridge network can't bind-mount /proc/<pid>/ns/net for the
  // build container, breaking any RUN that needs network (e.g. apt, curl).
  // Falling back to host networking sidesteps the missing capability.
  const args = ['build', '-t', ref, '-f', dockerfile];
  for (const [k, v] of Object.entries(opts.buildArgs ?? {})) {
    args.push('--build-arg', `${k}=${v}`);
  }
  args.push(contextDir);
  if (process.env.AGENTBOX === '1') {
    args.splice(1, 0, '--network=host');
  }

  const subprocess = execa('docker', args, {
    stderr: 'pipe',
    stdout: 'pipe',
  });

  if (opts.onProgress) {
    const forward = (chunk: Buffer | string): void => {
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const line of text.split(/\r?\n/)) {
        if (line.length > 0) opts.onProgress?.(line);
      }
    };
    subprocess.stdout?.on('data', forward);
    subprocess.stderr?.on('data', forward);
  }

  await subprocess;
  return ref;
}

export interface PullOrBuildOptions {
  onProgress?: (line: string) => void;
  /** Dockerfile path. Defaults to `Dockerfile.box` next to this package. */
  dockerfile?: string;
  /** Build context directory. Defaults to the staged runtime / monorepo root. */
  contextDir?: string;
  /** Try the registry before building. Defaults to true. */
  allowPull?: boolean;
  /** Registry repo to pull from. Defaults to `BOX_IMAGE_REGISTRY`; empty disables pulling. */
  registry?: string;
  /** `--build-arg K=V` pairs forwarded to the local `docker build` (ignored on a registry pull). */
  buildArgs?: Record<string, string>;
}

/**
 * Make `ref` present locally, preferring a registry pull over a local build.
 *
 * When `fingerprint` is non-null and pulling is allowed, pull the
 * fingerprint-tagged image and retag it to `ref`; on a miss (or when pulling
 * is disabled / unfingerprintable) build from the staged context. Either way,
 * a known fingerprint is stamped into docker-prepared.json so the next
 * `ensureImage()` treats this as a cache hit.
 */
export async function pullOrBuild(
  ref: string,
  fingerprint: { contextSha256: string } | null,
  opts: PullOrBuildOptions = {},
): Promise<{ source: 'pulled' | 'built' }> {
  const { writePreparedDockerState } = await import('./prepared-state.js');
  const registry = opts.registry ?? BOX_IMAGE_REGISTRY;
  const allowPull = opts.allowPull !== false;

  if (allowPull && registry && fingerprint) {
    const target = registryRefForSha(fingerprint.contextSha256, registry);
    opts.onProgress?.(`[image] pulling ${target}`);
    if (await pullImage(target, { onProgress: opts.onProgress })) {
      await tagImage(target, ref);
      writePreparedDockerState({ imageRef: ref, contextSha256: fingerprint.contextSha256 });
      opts.onProgress?.(`[image] pulled ${target} -> ${ref}`);
      return { source: 'pulled' };
    }
    opts.onProgress?.(`[image] registry miss, building ${ref} locally`);
  }

  await buildImage({
    ref,
    dockerfile: opts.dockerfile,
    contextDir: opts.contextDir,
    buildArgs: opts.buildArgs,
    onProgress: opts.onProgress,
  });
  if (fingerprint) {
    writePreparedDockerState({ imageRef: ref, contextSha256: fingerprint.contextSha256 });
  }
  return { source: 'built' };
}

export interface EnsureImageOptions {
  onProgress?: (line: string) => void;
  /** Dockerfile path. Defaults to `Dockerfile.box` next to this package. */
  dockerfile?: string;
  /** Build context directory. Defaults to the monorepo root. */
  contextDir?: string;
  /** Try the registry before building. Defaults to true. */
  allowPull?: boolean;
  /** Registry repo to pull from. Defaults to `BOX_IMAGE_REGISTRY`; empty disables pulling. */
  registry?: string;
  /**
   * How Claude Code is installed into the image. Folded into the build-context
   * fingerprint so a mode switch rebuilds (and an npm image isn't clobbered by
   * a native rebuild). Defaults to the resolved `box.claudeInstall`.
   */
  claudeInstall?: 'native' | 'npm';
}

export async function ensureImage(
  ref: string = DEFAULT_BOX_IMAGE,
  opts: EnsureImageOptions = {},
): Promise<{ ref: string; built: boolean; reason?: string }> {
  // Lazy import: prepared-state imports back into image.ts for the default
  // DOCKERFILE_PATH/BUILD_CONTEXT_DIR constants, so loading it at top-level
  // would create a circular ESM init order.
  const { computeDockerContextFingerprint, readPreparedDockerState, preparedMatches } =
    await import('./prepared-state.js');

  const claudeInstall = opts.claudeInstall ?? (await resolveClaudeInstallMode());
  const rawFingerprint = await computeDockerContextFingerprint({
    contextDir: opts.contextDir,
  });
  // Fold the install mode into the sha so native↔npm are distinct cache
  // identities (`native` leaves the hash unchanged).
  const fingerprint = rawFingerprint
    ? {
        ...rawFingerprint,
        contextSha256: claudeInstallFingerprint(rawFingerprint.contextSha256, claudeInstall),
      }
    : null;
  const prepared = readPreparedDockerState();
  const exists = await imageExists(ref);

  let reason: string | undefined;
  if (!exists) {
    reason = `image ${ref} not present`;
  } else if (!fingerprint) {
    // Couldn't enumerate the context (partial dev rebuild?). Don't rebuild
    // unconditionally — that would surprise users mid-iteration. Trust the
    // image-exists check and leave the prepared file untouched.
    return { ref, built: false, reason: 'image present (fingerprint skipped)' };
  } else if (!prepared) {
    reason = 'no docker-prepared.json on disk';
  } else if (!preparedMatches(prepared, fingerprint.contextSha256)) {
    reason =
      `build context changed (was ${prepared.base?.contextSha256?.slice(0, 12) ?? '<none>'}, ` +
      `now ${fingerprint.contextSha256.slice(0, 12)})`;
  }

  if (!reason) {
    return { ref, built: false, reason: 'image up to date' };
  }

  opts.onProgress?.(`[image] ${ref}: ${reason}`);
  const npm = claudeInstall === 'npm';
  const { source } = await pullOrBuild(ref, fingerprint, {
    onProgress: opts.onProgress,
    dockerfile: opts.dockerfile,
    contextDir: opts.contextDir,
    // The published GHCR image is native-only, so npm mode must build locally.
    allowPull: npm ? false : opts.allowPull,
    registry: opts.registry,
    buildArgs: npm ? { AGENTBOX_CLAUDE_INSTALL: 'npm' } : undefined,
  });
  return { ref, built: source === 'built', reason };
}

/**
 * Read-only freshness classification of the docker base image, for surfaces
 * (hub API, tray) that want to announce an upcoming bake without triggering
 * it. `unknown` means "couldn't fingerprint" and MUST stay inert — the
 * matching `ensureImage` path trusts the existing image and does not rebuild.
 */
export type DockerBaseFreshness =
  | { state: 'fresh' }
  | { state: 'unknown' }
  | { state: 'unprepared' }
  | { state: 'stale'; reason: string };

/**
 * Pure decision core shared by `evaluateDockerBaseFreshness`. Mirrors
 * `ensureImage`'s rebuild predicate exactly — if the two ever disagree, the
 * freshness surfaces would announce a bake that create then skips (or miss
 * one it performs). `stampedSha` is `docker-prepared.json`'s fingerprint,
 * null when the stamp is missing/invalid.
 */
export function classifyDockerBaseFreshness(input: {
  imagePresent: boolean;
  fingerprint: string | null;
  stampedSha: string | null;
}): DockerBaseFreshness {
  if (!input.imagePresent) return { state: 'unprepared' };
  if (!input.fingerprint) return { state: 'unknown' };
  if (!input.stampedSha) return { state: 'stale', reason: 'no docker-prepared.json on disk' };
  if (input.stampedSha !== input.fingerprint) {
    return {
      state: 'stale',
      reason:
        `build context changed (was ${input.stampedSha.slice(0, 12)}, ` +
        `now ${input.fingerprint.slice(0, 12)})`,
    };
  }
  return { state: 'fresh' };
}

/**
 * Cheap live check: would `ensureImage` bake on the next create? The only
 * docker work is one `docker image inspect`; the rest hashes the ~15 build
 * context files. Never builds, pulls, or writes the prepared stamp.
 */
export async function evaluateDockerBaseFreshness(
  opts: { ref?: string; claudeInstall?: 'native' | 'npm'; contextDir?: string } = {},
): Promise<DockerBaseFreshness> {
  // Lazy import for the same circular-init reason as in ensureImage above.
  const { computeDockerContextFingerprint, readPreparedDockerState } =
    await import('./prepared-state.js');
  const ref = opts.ref ?? DEFAULT_BOX_IMAGE;
  const imagePresent = await imageExists(ref);
  if (!imagePresent) return { state: 'unprepared' };
  const claudeInstall = opts.claudeInstall ?? (await resolveClaudeInstallMode());
  const raw = await computeDockerContextFingerprint({ contextDir: opts.contextDir });
  return classifyDockerBaseFreshness({
    imagePresent,
    fingerprint: raw ? claudeInstallFingerprint(raw.contextSha256, claudeInstall) : null,
    stampedSha: readPreparedDockerState()?.base?.contextSha256 ?? null,
  });
}

