/**
 * Locate the staged CLI runtime tree — the `runtime/` directory holding the
 * per-provider subtrees (`e2b/`, `vercel/`, `hetzner/`, `digitalocean/`,
 * `docker/`, `daytona/`) whose bytes the base fingerprint hashes.
 *
 * Every provider resolves this the same two ways: relative to its own bundle
 * (`<dist>/../runtime`, `<dist>/../../runtime`) which works for the CLI (staged
 * next to `apps/cli/dist`) and a published install. That relative lookup fails
 * for a **source-deployed control-box hub**: its bundle lives under
 * `apps/hub/dist-standalone/**`, nowhere near the staged tree at
 * `apps/cli/runtime`, so it silently falls back to hashing the monorepo
 * `packages/**` source instead — which differs from the staged tree and yields
 * a different fingerprint than the CLI baked with. The hub then rejects every
 * PC-baked custody record as "a different build context" and never adopts it.
 *
 * `AGENTBOX_RUNTIME_ROOT` closes that gap: point it at the staged `runtime/`
 * dir and any consumer (hub included) computes the same fingerprint the CLI
 * does. The deploy sets it for the hub container.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Env override naming the staged `runtime/` root explicitly. */
export const RUNTIME_ROOT_ENV = 'AGENTBOX_RUNTIME_ROOT';

/**
 * Candidate staged-runtime roots, override first. `self` is the caller module's
 * directory (`dirname(fileURLToPath(import.meta.url))`).
 */
export function stagedRuntimeRootCandidates(self: string): string[] {
  const candidates: string[] = [];
  const override = process.env[RUNTIME_ROOT_ENV];
  if (override) candidates.push(override);
  candidates.push(resolve(self, '..', 'runtime'), resolve(self, '..', '..', 'runtime'));
  return candidates;
}

/**
 * Resolve the staged runtime root, verifying it via a provider-specific marker
 * (a relative path known to exist under a valid root, e.g.
 * `e2b/scripts/build-template.sh`). Returns `undefined` when no candidate holds
 * the marker — callers then fall back to the monorepo source tree.
 */
export function resolveStagedRuntimeRoot(self: string, marker: string): string | undefined {
  for (const candidate of stagedRuntimeRootCandidates(self)) {
    if (existsSync(resolve(candidate, marker))) return candidate;
  }
  return undefined;
}
