/**
 * Resolver for the on-disk files we need to ship into a fresh VPS during
 * `prepareHetzner()` — same shape as the docker provider's runtime/docker
 * staging, but lighter (no Dockerfile build, just a flat tarball of files
 * to scp into /tmp).
 *
 * Lookup order for each file:
 *   1. The CLI's staged runtime tree: `<cliRoot>/runtime/hetzner/...`
 *      (populated by `apps/cli/scripts/stage-runtime.mjs`).
 *   2. The monorepo source tree (dev fallback): the file's canonical
 *      package-relative path under `packages/`.
 *
 * Failure mode: any missing file throws a clear error naming the lookup
 * paths so a partial dev rebuild is obvious to debug.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStagedRuntimeRoot } from '@agentbox/sandbox-core';

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Locate the staged `runtime/hetzner/` tree. Two candidates:
 *
 *   1. Bundled CLI: the hetzner module is inlined into apps/cli's dist/, so
 *      `dirname(import.meta.url)` is `<cliRoot>/dist`; the staged runtime
 *      sits at `<cliRoot>/runtime/hetzner`.
 *   2. Workspace dev: this module's dist is at
 *      `packages/sandbox-hetzner/dist/`. There's no staged runtime there;
 *      callers fall through to the monorepo source paths in
 *      `candidatesFor()`. Returns undefined in that case.
 *
 * The CLI doesn't have to pass `cliRuntimeRoot` explicitly — this helper
 * picks it up by inspecting where the module was loaded from.
 */
export function findStagedCliRuntimeRoot(): string | undefined {
  return resolveStagedRuntimeRoot(SELF, 'hetzner/scripts/install-box.sh');
}

/**
 * Each runtime asset has a stable, well-known destination basename in
 * `/tmp` on the prepare VPS and is resolved from one of N candidate
 * source paths on the host.
 */
export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines). */
  name: string;
  /** Basename on the prepare VPS (under /tmp/). */
  remoteBasename: string;
  /** Optional file mode at scp-time. */
  remoteMode?: number;
}

export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'install-box.sh', remoteBasename: 'agentbox-install.sh', remoteMode: 0o755 },
  { name: 'agentbox-ctl', remoteBasename: 'agentbox-ctl', remoteMode: 0o755 },
  { name: 'agentbox-vnc-start', remoteBasename: 'agentbox-vnc-start', remoteMode: 0o755 },
  { name: 'agentbox-dockerd-start', remoteBasename: 'agentbox-dockerd-start', remoteMode: 0o755 },
  { name: 'agentbox-portless-trust', remoteBasename: 'agentbox-portless-trust', remoteMode: 0o755 },
  { name: 'agentbox-checkpoint-cleanup', remoteBasename: 'agentbox-checkpoint-cleanup', remoteMode: 0o755 },
  { name: 'agentbox-open', remoteBasename: 'agentbox-open', remoteMode: 0o755 },
  { name: 'gh-shim', remoteBasename: 'agentbox-gh-shim', remoteMode: 0o755 },
  { name: 'git-shim', remoteBasename: 'agentbox-git-shim', remoteMode: 0o755 },
  { name: 'ntn-shim', remoteBasename: 'agentbox-ntn-shim', remoteMode: 0o755 },
  { name: 'linear-shim', remoteBasename: 'agentbox-linear-shim', remoteMode: 0o755 },
  { name: 'custom-system-CLAUDE.md', remoteBasename: 'agentbox-custom-CLAUDE.md', remoteMode: 0o644 },
  { name: 'claude-managed-settings.json', remoteBasename: 'agentbox-managed-settings.json', remoteMode: 0o644 },
  { name: 'agentbox-codex-hooks.json', remoteBasename: 'agentbox-codex-hooks.json', remoteMode: 0o644 },
  { name: 'agentbox-setup-skill.md', remoteBasename: 'agentbox-setup-skill.md', remoteMode: 0o644 },
] as const;

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
}

/**
 * Build the candidate search paths for a given asset. Tries CLI runtime
 * first, then the monorepo source tree. The first one that exists wins.
 *
 * `cliRuntimeRoot` is provided by the caller because we don't know how the
 * embedding CLI lays out its dist (the @madarco/agentbox CLI puts dist + a
 * sibling runtime/ next to it; tests pass a tmp dir). Use the helper
 * `findCliRuntimeRoot()` below from the calling context that has the right
 * anchor (typically `import.meta.url` of an apps/cli module).
 */
export function candidatesFor(
  name: string,
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): string[] {
  const cliRoot = opts.cliRuntimeRoot;
  const monorepo = opts.repoRoot ?? guessRepoRoot();

  // Map logical → relative paths (relative to either anchor).
  const monorepoRelative: Record<string, string[]> = {
    'install-box.sh': ['packages/sandbox-hetzner/scripts/install-box.sh'],
    'agentbox-ctl': ['packages/ctl/dist/bin.cjs'],
    'agentbox-vnc-start': ['packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-dockerd-start': ['packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-portless-trust': ['packages/sandbox-docker/scripts/agentbox-portless-trust'],
    'agentbox-checkpoint-cleanup': ['packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['packages/sandbox-hetzner/scripts/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['apps/cli/share/agentbox-setup/SKILL.md'],
  };

  // CLI-runtime-tree relative paths (mirrors the staging layout).
  const cliRelative: Record<string, string[]> = {
    'install-box.sh': ['hetzner/scripts/install-box.sh'],
    'agentbox-ctl': ['hetzner/ctl.cjs'],
    'agentbox-vnc-start': ['hetzner/agentbox-vnc-start', 'docker/packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-dockerd-start': ['hetzner/agentbox-dockerd-start', 'docker/packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-portless-trust': ['hetzner/agentbox-portless-trust', 'docker/packages/sandbox-docker/scripts/agentbox-portless-trust'],
    'agentbox-checkpoint-cleanup': ['hetzner/agentbox-checkpoint-cleanup', 'docker/packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['hetzner/agentbox-open', 'docker/packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['hetzner/gh-shim', 'docker/packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['hetzner/git-shim', 'docker/packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['hetzner/ntn-shim', 'docker/packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['hetzner/linear-shim', 'docker/packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['hetzner/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['hetzner/claude-managed-settings.json', 'docker/packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['hetzner/agentbox-codex-hooks.json', 'docker/packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['hetzner/agentbox-setup-skill.md', 'docker/apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const out: string[] = [];
  if (cliRoot) {
    for (const rel of cliRelative[name] ?? []) out.push(resolve(cliRoot, rel));
  }
  for (const rel of monorepoRelative[name] ?? []) out.push(resolve(monorepo, rel));
  return out;
}

/**
 * Resolve every runtime asset to its absolute on-host path. Throws an
 * actionable error if any asset can't be found (lists every path tried).
 */
export function resolveRuntimeAssets(opts: {
  cliRuntimeRoot?: string;
  repoRoot?: string;
} = {}): ResolvedAsset[] {
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
      `hetzner: could not resolve runtime assets — these files are needed to install on the prepare VPS:\n` +
        lines.join('\n') +
        `\n\nIf you are running from the monorepo, ensure \`pnpm -w build\` has run so packages/ctl/dist/bin.cjs exists. ` +
        `If you are running from a published CLI bundle, the runtime/hetzner tree should be staged automatically.`,
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
  return SELF; // fall through to itself; resolution will fail with a clear error
}
