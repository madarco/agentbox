import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
 *   0. AGENTBOX_DOCKER_CONTEXT env override.
 *   1. Staged context shipped with the bundled `agent-box` package (sibling
 *      of dist/, uniform in dev + installed).
 *   2. Legacy monorepo layout: Dockerfile.box at sandbox-docker's package
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
