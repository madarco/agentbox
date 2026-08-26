/**
 * Resolver for the control-box deploy files scp'd onto a fresh VPS by
 * `agentbox hub deploy hetzner` — the compose stack the `app` service is built
 * from. Same two-candidate shape as `runtime-assets.ts` (the box-side assets):
 *
 *   1. The CLI's staged runtime tree: `<cliRoot>/runtime/hub-deploy/<basename>`
 *      (populated by `apps/cli/scripts/stage-runtime.mjs`).
 *   2. The monorepo source tree (dev fallback): `apps/hub/<basename>`.
 *
 * In package mode there is no repo on the VPS, so every file the deploy needs
 * has to travel from the host. `docker-compose.yml` is shipped verbatim and
 * shared with the source path, which is what keeps the service's
 * environment/volumes/ports block from drifting between the two modes.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStagedRuntimeRoot } from '@agentbox/sandbox-core';

const SELF = dirname(fileURLToPath(import.meta.url));

/** The files, by basename — identical under `runtime/hub-deploy/` and `apps/hub/`. */
export const HUB_DEPLOY_ASSETS = [
  'docker-compose.yml',
  'docker-compose.package.yml',
  'Dockerfile.package',
] as const;

export type HubDeployAsset = (typeof HUB_DEPLOY_ASSETS)[number];

/**
 * Locate the staged `runtime/hub-deploy/` tree. Undefined in a workspace dev
 * build, where this module's dist has no staged runtime beside it and callers
 * fall through to the monorepo source paths.
 */
export function findStagedHubDeployRoot(): string | undefined {
  const root = resolveStagedRuntimeRoot(SELF, 'hub-deploy/docker-compose.yml');
  return root === undefined ? undefined : resolve(root, 'hub-deploy');
}

/** Candidate paths for one asset, staged tree first. Pure — unit-testable. */
export function hubDeployCandidates(
  asset: HubDeployAsset,
  opts: { stagedRoot?: string; repoRoot?: string } = {},
): string[] {
  const out: string[] = [];
  const staged = opts.stagedRoot ?? findStagedHubDeployRoot();
  if (staged) out.push(resolve(staged, asset));
  out.push(resolve(opts.repoRoot ?? guessRepoRoot(), 'apps', 'hub', asset));
  return out;
}

/**
 * Resolve every deploy asset to an absolute host path. Throws an actionable
 * error listing every path tried — a partial dev build (no staged runtime, no
 * monorepo) is otherwise a confusing scp failure mid-deploy.
 */
export function resolveHubDeployAssets(
  opts: { stagedRoot?: string; repoRoot?: string } = {},
): Record<HubDeployAsset, string> {
  const out = {} as Record<HubDeployAsset, string>;
  const missing: Array<{ name: string; tried: string[] }> = [];
  for (const asset of HUB_DEPLOY_ASSETS) {
    const tried = hubDeployCandidates(asset, opts);
    const hit = tried.find((p) => existsSync(p));
    if (!hit) {
      missing.push({ name: asset, tried });
      continue;
    }
    out[asset] = hit;
  }
  if (missing.length > 0) {
    const lines = missing.flatMap((m) => [
      `  - ${m.name}: tried`,
      ...m.tried.map((p) => `      ${p}`),
    ]);
    throw new Error(
      "hetzner: could not resolve the control-box deploy assets — these files are scp'd onto the VPS:\n" +
        lines.join('\n') +
        '\n\nIf you are running from a published CLI bundle, the runtime/hub-deploy tree should be staged ' +
        'automatically (`pnpm --filter @madarco/agentbox stage`).',
    );
  }
  return out;
}

/** Best-effort: walk up from this file looking for `pnpm-workspace.yaml`. */
function guessRepoRoot(): string {
  let cur = SELF;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, 'pnpm-workspace.yaml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return SELF; // fall through to itself; resolution fails with a clear error
}
