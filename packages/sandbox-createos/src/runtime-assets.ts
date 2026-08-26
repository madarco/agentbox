import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = dirname(fileURLToPath(import.meta.url));

export interface RuntimeAsset {
  name: string;
  remoteBasename: string;
  remoteMode?: number;
}

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
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

export function findStagedCliRuntimeRoot(): string | undefined {
  for (const c of [resolve(SELF, '..', 'runtime'), resolve(SELF, '..', '..', 'runtime')]) {
    if (existsSync(resolve(c, 'createos', 'scripts', 'install-box.sh'))) return c;
  }
  return undefined;
}

export function candidatesFor(
  name: string,
  opts: { cliRuntimeRoot?: string; repoRoot?: string } = {},
): string[] {
  const cliRoot = opts.cliRuntimeRoot;
  const monorepo = opts.repoRoot ?? guessRepoRoot();
  const monorepoRelative: Record<string, string[]> = {
    'install-box.sh': ['packages/sandbox-createos/scripts/install-box.sh'],
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
    'custom-system-CLAUDE.md': ['packages/sandbox-createos/scripts/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['apps/cli/share/agentbox-setup/SKILL.md'],
  };
  const cliRelative: Record<string, string[]> = {
    'install-box.sh': ['createos/scripts/install-box.sh', 'hetzner/scripts/install-box.sh'],
    'agentbox-ctl': ['createos/ctl.cjs', 'hetzner/ctl.cjs'],
    'agentbox-vnc-start': ['createos/agentbox-vnc-start', 'docker/packages/sandbox-docker/scripts/agentbox-vnc-start'],
    'agentbox-dockerd-start': ['createos/agentbox-dockerd-start', 'docker/packages/sandbox-docker/scripts/agentbox-dockerd-start'],
    'agentbox-portless-trust': ['createos/agentbox-portless-trust', 'docker/packages/sandbox-docker/scripts/agentbox-portless-trust'],
    'agentbox-checkpoint-cleanup': ['createos/agentbox-checkpoint-cleanup', 'docker/packages/sandbox-docker/scripts/agentbox-checkpoint-cleanup'],
    'agentbox-open': ['createos/agentbox-open', 'docker/packages/sandbox-docker/scripts/agentbox-open'],
    'gh-shim': ['createos/gh-shim', 'docker/packages/sandbox-docker/scripts/gh-shim'],
    'git-shim': ['createos/git-shim', 'docker/packages/sandbox-docker/scripts/git-shim'],
    'ntn-shim': ['createos/ntn-shim', 'docker/packages/sandbox-docker/scripts/ntn-shim'],
    'linear-shim': ['createos/linear-shim', 'docker/packages/sandbox-docker/scripts/linear-shim'],
    'custom-system-CLAUDE.md': ['createos/custom-system-CLAUDE.md', 'hetzner/custom-system-CLAUDE.md'],
    'claude-managed-settings.json': ['createos/claude-managed-settings.json', 'docker/packages/sandbox-docker/scripts/claude-managed-settings.json'],
    'agentbox-codex-hooks.json': ['createos/agentbox-codex-hooks.json', 'docker/packages/sandbox-docker/scripts/agentbox-codex-hooks.json'],
    'agentbox-setup-skill.md': ['createos/agentbox-setup-skill.md', 'docker/apps/cli/share/agentbox-setup/SKILL.md'],
  };

  const out: string[] = [];
  if (cliRoot) for (const rel of cliRelative[name] ?? []) out.push(resolve(cliRoot, rel));
  for (const rel of monorepoRelative[name] ?? []) out.push(resolve(monorepo, rel));
  return out;
}

export function resolveRuntimeAssets(opts: {
  cliRuntimeRoot?: string;
  repoRoot?: string;
} = {}): ResolvedAsset[] {
  const out: ResolvedAsset[] = [];
  const missing: Array<{ name: string; tried: string[] }> = [];
  for (const asset of RUNTIME_ASSETS) {
    const tried = candidatesFor(asset.name, opts);
    const hit = tried.find((p) => existsSync(p));
    if (hit) out.push({ ...asset, localPath: hit });
    else missing.push({ name: asset.name, tried });
  }
  if (missing.length > 0) {
    const lines = missing.flatMap((m) => [`  - ${m.name}: tried`, ...m.tried.map((p) => `      ${p}`)]);
    throw new Error(
      `createos: could not resolve runtime assets:\n${lines.join('\n')}\n\nRun \`pnpm -w build\` first so packages/ctl/dist/bin.cjs exists.`,
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
