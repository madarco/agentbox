/**
 * Resolver for the runtime payload baked into the E2B base template during
 * `prepareE2b()`. Same idea as the vercel resolver: a flat list of files to
 * `template.copy` into the build context, each resolved from either the
 * staged CLI runtime tree or the monorepo source tree.
 *
 * Lookup order per file:
 *   1. The CLI's staged runtime tree: `<cliRoot>/e2b/...`.
 *   2. The monorepo source tree (dev fallback) under `packages/`.
 *
 * Any missing file throws a clear error naming the paths tried. Note: no
 * dockerd helper — E2B microVMs can't run nested containers.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

export function findStagedCliRuntimeRoot(): string | undefined {
  const candidates = [resolve(SELF, '..', 'runtime'), resolve(SELF, '..', '..', 'runtime')];
  for (const c of candidates) {
    if (existsSync(resolve(c, 'e2b', 'scripts', 'build-template.sh'))) return c;
  }
  return undefined;
}

export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines). */
  name: string;
  /** Absolute path inside the template's build filesystem (Template.copy target). */
  remotePath: string;
  /** File mode to apply after upload. */
  remoteMode: number;
}

/**
 * Where each asset lands inside the sandbox during template build. build-template.sh
 * reads them from these fixed paths. The agent/runtime helpers go straight to
 * /usr/local/bin via the script; baked config files to /tmp for the script to
 * `install` into place.
 */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'build-template.sh', remotePath: '/tmp/agentbox-build-template.sh', remoteMode: 0o755 },
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', remoteMode: 0o755 },
  { name: 'agentbox-vnc-start', remotePath: '/tmp/agentbox-vnc-start', remoteMode: 0o755 },
  { name: 'agentbox-checkpoint-cleanup', remotePath: '/tmp/agentbox-checkpoint-cleanup', remoteMode: 0o755 },
  { name: 'agentbox-open', remotePath: '/tmp/agentbox-open', remoteMode: 0o755 },
  { name: 'gh-shim', remotePath: '/tmp/agentbox-gh-shim', remoteMode: 0o755 },
  { name: 'git-shim', remotePath: '/tmp/agentbox-git-shim', remoteMode: 0o755 },
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
    'build-template.sh': ['packages/sandbox-e2b/scripts/build-template.sh'],
    'agentbox-ctl': ['packages/ctl/dist/bin.cjs'],
    'agentbox-vnc-start': ['packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-checkpoint-cleanup': ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['packages/sandbox-docker/scripts/git-shim'],
    'custom-system-CLAUDE.md': ['packages/sandbox-e2b/scripts/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const cliRelative: Record<string, string[]> = {
    'build-template.sh': ['e2b/scripts/build-template.sh'],
    'agentbox-ctl': ['e2b/ctl.cjs'],
    'agentbox-vnc-start': ['e2b/agentbox-vnc-start', 'docker/packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-checkpoint-cleanup': ['e2b/agentbox-checkpoint-cleanup', 'docker/packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['e2b/agentbox-open', 'docker/packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['e2b/gh-shim', 'docker/packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['e2b/git-shim', 'docker/packages/sandbox-docker/scripts/git-shim'],
    'custom-system-CLAUDE.md': ['e2b/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['e2b/claude-managed-settings.json', 'docker/packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['e2b/agentbox-codex-hooks.json', 'docker/packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['e2b/agentbox-setup-skill.md', 'docker/apps/cli/share/agentbox-setup/SKILL.md'],
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
      `e2b: could not resolve runtime assets needed to bake the base template:\n` +
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
