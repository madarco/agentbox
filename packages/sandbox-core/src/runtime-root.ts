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
 * The same miss hits a PACKAGE-installed hub, for a different reason: its bundle
 * sits at `<cli>/runtime/hub/apps/hub`, three levels below the staged root, so
 * neither candidate reaches `<cli>/runtime` — and with no monorepo to fall back
 * to, every cloud provider's live fingerprint comes back undefined.
 *
 * `AGENTBOX_RUNTIME_ROOT` closes both gaps: point it at the staged `runtime/`
 * dir and any consumer (hub included) computes the same fingerprint the CLI
 * does. Two places set it: `spawnHub` (@agentbox/sandbox-docker) for every
 * CLI-spawned hub, and the VPS deploy Dockerfile for the hub container.
 */
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Env var the CLI stamps at startup with its staged `runtime/` root. Mirrors
 * `CLI_RUNTIME_DIR_ENV` in `@madarco/agentbox-provider-sdk` — deliberately a
 * second literal rather than an import, because the SDK inlines this package
 * and depending on it here would be a cycle.
 */
export const CLI_RUNTIME_DIR_ENV = 'AGENTBOX_CLI_RUNTIME_DIR';

/**
 * Absolute host path to a provider-NEUTRAL asset staged under
 * `runtime/_shared/`, or null when it can't be found.
 *
 * Null rather than throwing: the one caller is best-effort seeding, where a
 * missing host copy just means we fall back to whatever the box image baked.
 */
export function sharedRuntimeAssetPath(basename: string): string | null {
  const roots: string[] = [];
  const stamped = process.env[CLI_RUNTIME_DIR_ENV];
  if (stamped) roots.push(stamped);
  const self = dirname(fileURLToPath(import.meta.url));
  const found = resolveStagedRuntimeRoot(self, `_shared/${basename}`);
  if (found) roots.push(found);
  for (const root of roots) {
    const p = resolve(root, '_shared', basename);
    if (existsSync(p)) return p;
  }
  return null;
}
