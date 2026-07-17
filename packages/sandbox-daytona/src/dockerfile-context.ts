import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_ROOT_ENV } from '@agentbox/sandbox-core';

/**
 * Locate `Dockerfile.box` + its build context so Daytona can `Image.fromDockerfile`
 * the same image the Docker provider builds locally. The Dockerfile COPYs from
 * the monorepo (packages/ctl/dist/bin.cjs, apps/cli/share/..., scripts/), so
 * the context dir must contain that tree.
 *
 * Mirrors `@agentbox/sandbox-docker`'s `resolveDockerBuild`, intentionally
 * inlined: sandbox-daytona must not depend on sandbox-docker (cross-provider
 * dep would defeat the point of `@agentbox/sandbox-cloud`).
 *
 * Resolution order:
 *   0. AGENTBOX_DOCKER_CONTEXT env override (points straight at a context dir).
 *   1. AGENTBOX_RUNTIME_ROOT env override → `<root>/docker` (the staged runtime
 *      root; lets a source-deployed hub hash the SAME context the CLI baked).
 *   2. Staged context shipped with the bundled `agent-box` package (sibling
 *      of dist/, uniform in dev + installed).
 *   3. Legacy monorepo layout: Dockerfile.box at sandbox-docker's package
 *      root, context = monorepo root.
 */
export interface DockerfileContext {
  dockerfile: string;
  context: string;
}

export function resolveDockerfileContext(): DockerfileContext | null {
  const override = process.env.AGENTBOX_DOCKER_CONTEXT;
  if (override && existsSync(resolve(override, 'Dockerfile.box'))) {
    return { dockerfile: resolve(override, 'Dockerfile.box'), context: override };
  }
  const runtimeRoot = process.env[RUNTIME_ROOT_ENV];
  if (runtimeRoot) {
    const ctx = resolve(runtimeRoot, 'docker');
    if (existsSync(resolve(ctx, 'Dockerfile.box'))) {
      return { dockerfile: resolve(ctx, 'Dockerfile.box'), context: ctx };
    }
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const staged = resolve(here, '..', 'runtime', 'docker');
  if (existsSync(resolve(staged, 'Dockerfile.box'))) {
    return { dockerfile: resolve(staged, 'Dockerfile.box'), context: staged };
  }
  // Legacy monorepo: this module is at packages/sandbox-daytona/dist; the
  // Dockerfile lives at packages/sandbox-docker/Dockerfile.box; the build
  // context is the monorepo root.
  const monorepoRoot = resolve(here, '..', '..', '..');
  const dockerfile = resolve(monorepoRoot, 'packages', 'sandbox-docker', 'Dockerfile.box');
  if (existsSync(dockerfile)) {
    return { dockerfile, context: monorepoRoot };
  }
  return null;
}

/**
 * Locate the daytona-specific `custom-system-CLAUDE.md` that overlays the
 * docker-shaped one baked into `Dockerfile.box`. Daytona boxes have no host
 * `.git/` bind-mount, so the in-box hint needs daytona-specific git wording
 * (use `agentbox-ctl git` for any host-touching op). Same two-tier lookup
 * shape as `resolveDockerfileContext()`: staged CLI runtime first, monorepo
 * source as the dev fallback.
 */
export function resolveDaytonaCustomClaudeMd(): string | null {
  const runtimeRoot = process.env[RUNTIME_ROOT_ENV];
  if (runtimeRoot) {
    const overrideMd = resolve(runtimeRoot, 'daytona', 'custom-system-CLAUDE.md');
    if (existsSync(overrideMd)) return overrideMd;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const staged = resolve(here, '..', 'runtime', 'daytona', 'custom-system-CLAUDE.md');
  if (existsSync(staged)) return staged;
  const monorepoRoot = resolve(here, '..', '..', '..');
  const dev = resolve(
    monorepoRoot,
    'packages',
    'sandbox-daytona',
    'scripts',
    'custom-system-CLAUDE.md',
  );
  if (existsSync(dev)) return dev;
  return null;
}
