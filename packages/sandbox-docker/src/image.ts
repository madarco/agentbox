import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const DEFAULT_BOX_IMAGE = 'agentbox/box:dev';

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
  const args = ['build', '-t', ref, '-f', dockerfile, contextDir];
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

export interface EnsureImageOptions {
  onProgress?: (line: string) => void;
  /** Dockerfile path. Defaults to `Dockerfile.box` next to this package. */
  dockerfile?: string;
  /** Build context directory. Defaults to the monorepo root. */
  contextDir?: string;
}

export async function ensureImage(
  ref: string = DEFAULT_BOX_IMAGE,
  opts: EnsureImageOptions = {},
): Promise<{ ref: string; built: boolean }> {
  if (await imageExists(ref)) {
    return { ref, built: false };
  }
  await buildImage({
    ref,
    dockerfile: opts.dockerfile,
    contextDir: opts.contextDir,
    onProgress: opts.onProgress,
  });
  return { ref, built: true };
}

