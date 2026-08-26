/**
 * Resolver for the on-disk files shipped into a fresh Vercel sandbox during
 * `prepareVercel()`. Same idea as the hetzner resolver: a flat list of files to
 * upload via `sandbox.writeFiles`, each resolved from either the staged CLI
 * runtime tree or the monorepo source tree.
 *
 * Lookup order per file:
 *   1. The CLI's staged runtime tree: `<cliRoot>/runtime/vercel/...`.
 *   2. The monorepo source tree (dev fallback) under `packages/`.
 *
 * Any missing file throws a clear error naming the paths tried. Includes the
 * shared `agentbox-dockerd-start` helper — Vercel now supports nested
 * containers, so the base snapshot bakes the docker engine + this launcher.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStagedRuntimeRoot } from '@agentbox/sandbox-core';

const SELF = dirname(fileURLToPath(import.meta.url));

export function findStagedCliRuntimeRoot(): string | undefined {
  return resolveStagedRuntimeRoot(SELF, 'vercel/scripts/provision.sh');
}

export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines). */
  name: string;
  /** Absolute path on the box (writeFiles target). */
  remotePath: string;
  /** File mode to apply after upload. */
  remoteMode: number;
}

/**
 * Where each asset lands inside the sandbox. provision.sh reads them from these
 * fixed paths. The agent/runtime helpers go straight to /usr/local/bin; baked
 * config files to /tmp for provision.sh to `install` into place.
 */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'provision.sh', remotePath: '/tmp/agentbox-provision.sh', remoteMode: 0o755 },
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', remoteMode: 0o755 },
  { name: 'agentbox-vnc-start', remotePath: '/tmp/agentbox-vnc-start', remoteMode: 0o755 },
  { name: 'agentbox-dockerd-start', remotePath: '/tmp/agentbox-dockerd-start', remoteMode: 0o755 },
  { name: 'agentbox-checkpoint-cleanup', remotePath: '/tmp/agentbox-checkpoint-cleanup', remoteMode: 0o755 },
  { name: 'agentbox-open', remotePath: '/tmp/agentbox-open', remoteMode: 0o755 },
  { name: 'gh-shim', remotePath: '/tmp/agentbox-gh-shim', remoteMode: 0o755 },
  { name: 'git-shim', remotePath: '/tmp/agentbox-git-shim', remoteMode: 0o755 },
  { name: 'ntn-shim', remotePath: '/tmp/agentbox-ntn-shim', remoteMode: 0o755 },
  { name: 'linear-shim', remotePath: '/tmp/agentbox-linear-shim', remoteMode: 0o755 },
  { name: 'custom-system-CLAUDE.md', remotePath: '/tmp/agentbox-custom-CLAUDE.md', remoteMode: 0o644 },
  { name: 'claude-managed-settings.json', remotePath: '/tmp/agentbox-managed-settings.json', remoteMode: 0o644 },
  { name: 'agentbox-codex-hooks.json', remotePath: '/tmp/agentbox-codex-hooks.json', remoteMode: 0o644 },
  { name: 'agentbox-setup-skill.md', remotePath: '/tmp/agentbox-setup-skill.md', remoteMode: 0o644 },
] as const;

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
}

export function candidatesFor(
  name: string,
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): string[] {
  const cliRoot = opts.cliRuntimeRoot;
  const monorepo = opts.repoRoot ?? guessRepoRoot();

  const monorepoRelative: Record<string, string[]> = {
    'provision.sh': ['packages/sandbox-vercel/scripts/provision.sh'],
    'agentbox-ctl': ['packages/ctl/dist/bin.cjs'],
    'agentbox-vnc-start': ['packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-dockerd-start': ['packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-checkpoint-cleanup': ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['packages/sandbox-vercel/scripts/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const cliRelative: Record<string, string[]> = {
    'provision.sh': ['vercel/scripts/provision.sh'],
    'agentbox-ctl': ['vercel/ctl.cjs'],
    'agentbox-vnc-start': ['vercel/agentbox-vnc-start', 'docker/packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-dockerd-start': ['vercel/agentbox-dockerd-start', 'docker/packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-checkpoint-cleanup': ['vercel/agentbox-checkpoint-cleanup', 'docker/packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['vercel/agentbox-open', 'docker/packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['vercel/gh-shim', 'docker/packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['vercel/git-shim', 'docker/packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['vercel/ntn-shim', 'docker/packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['vercel/linear-shim', 'docker/packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['vercel/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['vercel/claude-managed-settings.json', 'docker/packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['vercel/agentbox-codex-hooks.json', 'docker/packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['vercel/agentbox-setup-skill.md', 'docker/apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const out: string[] = [];
  if (cliRoot) {
    for (const rel of cliRelative[name] ?? []) out.push(resolve(cliRoot, rel));
  }
  for (const rel of monorepoRelative[name] ?? []) out.push(resolve(monorepo, rel));
  return out;
}

export function resolveRuntimeAssets(
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): ResolvedAsset[] {
  const out: ResolvedAsset[] = [];
  const missing: Array<{ name: string; tried: string[] }> = [];
  for (const asset of RUNTIME_ASSETS) {
    const cands = candidatesFor(asset.name, opts);
    const hit = cands.find((p) => existsSync(p));
    if (!hit) {
      missing.push({ name: asset.name, tried: cands });
      continue;
    }
    out.push({ ...asset, localPath: hit });
  }
  if (missing.length > 0) {
    const lines = missing.flatMap((m) => [`  - ${m.name}: tried`, ...m.tried.map((p) => `      ${p}`)]);
    throw new Error(
      `vercel: could not resolve runtime assets needed to bake the base snapshot:\n` +
        lines.join('\n') +
        `\n\nIf running from the monorepo, ensure \`pnpm -w build\` has run so packages/ctl/dist/bin.cjs exists.`,
    );
  }
  return out;
}

function guessRepoRoot(): string {
  let cur = SELF;
  for (let i = 0; i < 8; i++) {
    if (existsSync(resolve(cur, 'pnpm-workspace.yaml'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return SELF;
}
