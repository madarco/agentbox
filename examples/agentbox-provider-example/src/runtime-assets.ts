/**
 * Resolver for the on-disk files shipped into a fresh sandbox during
 * `prepareExample()`. This is the canonical demonstration of the plugin
 * box-runtime model (see docs/provider-plugins.md → "Box-side runtime"):
 *
 *   - **Shared, provider-neutral runtime** (`ctl.cjs` + the VNC/dockerd launchers
 *     and shims) is pulled from the *running CLI* via `resolveSharedRuntimeAsset`
 *     so it stays version-locked to the CLI. A plugin must NOT vendor its own copy.
 *   - **Provider-specific assets** (`provision.sh` + `custom-system-CLAUDE.md`)
 *     are vendored in this package's own `scripts/` dir and resolved relative to
 *     the built module. These are the only files a real plugin ships itself.
 *
 * Each entry is uploaded via `sandbox.writeFiles` at prepare time; provision.sh
 * reads them from the fixed `remotePath`s.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSharedRuntimeAsset } from '@madarco/agentbox-provider-sdk';

const SELF = dirname(fileURLToPath(import.meta.url));

/** The vendored `scripts/` dir. `dist/` (built) and `src/` (ts-node) both sit one level under the package root. */
function vendoredScript(basename: string): string {
  const candidates = [resolve(SELF, '..', 'scripts', basename), resolve(SELF, 'scripts', basename)];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) {
    throw new Error(
      `example provider: vendored asset '${basename}' not found (tried ${candidates.join(', ')}). ` +
        `Did the package ship its scripts/ dir?`,
    );
  }
  return hit;
}

export interface RuntimeAsset {
  /** Logical name (used in error messages + log lines + the context fingerprint). */
  name: string;
  /** Absolute path on the box (writeFiles target). provision.sh reads these fixed paths. */
  remotePath: string;
  /** File mode to apply after upload. */
  remoteMode: number;
  /** How to resolve the local source: a shared CLI asset by basename, or a vendored script. */
  source: { shared: string } | { vendored: string };
}

/**
 * Where each asset lands inside the sandbox + how its local source resolves.
 * The `shared` basenames must exist in the SDK's `SHARED_RUNTIME_ASSETS` list.
 */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'provision.sh', remotePath: '/tmp/agentbox-provision.sh', remoteMode: 0o755, source: { vendored: 'provision.sh' } },
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', remoteMode: 0o755, source: { shared: 'ctl.cjs' } },
  { name: 'agentbox-vnc-start', remotePath: '/tmp/agentbox-vnc-start', remoteMode: 0o755, source: { shared: 'agentbox-vnc-start' } },
  { name: 'agentbox-dockerd-start', remotePath: '/tmp/agentbox-dockerd-start', remoteMode: 0o755, source: { shared: 'agentbox-dockerd-start' } },
  { name: 'agentbox-checkpoint-cleanup', remotePath: '/tmp/agentbox-checkpoint-cleanup', remoteMode: 0o755, source: { shared: 'agentbox-checkpoint-cleanup' } },
  { name: 'agentbox-open', remotePath: '/tmp/agentbox-open', remoteMode: 0o755, source: { shared: 'agentbox-open' } },
  { name: 'gh-shim', remotePath: '/tmp/agentbox-gh-shim', remoteMode: 0o755, source: { shared: 'gh-shim' } },
  { name: 'git-shim', remotePath: '/tmp/agentbox-git-shim', remoteMode: 0o755, source: { shared: 'git-shim' } },
  { name: 'ntn-shim', remotePath: '/tmp/agentbox-ntn-shim', remoteMode: 0o755, source: { shared: 'ntn-shim' } },
  { name: 'linear-shim', remotePath: '/tmp/agentbox-linear-shim', remoteMode: 0o755, source: { shared: 'linear-shim' } },
  { name: 'custom-system-CLAUDE.md', remotePath: '/tmp/agentbox-custom-CLAUDE.md', remoteMode: 0o644, source: { vendored: 'custom-system-CLAUDE.md' } },
  { name: 'claude-managed-settings.json', remotePath: '/tmp/agentbox-managed-settings.json', remoteMode: 0o644, source: { shared: 'claude-managed-settings.json' } },
  { name: 'agentbox-codex-hooks.json', remotePath: '/tmp/agentbox-codex-hooks.json', remoteMode: 0o644, source: { shared: 'agentbox-codex-hooks.json' } },
  { name: 'agentbox-setup-skill.md', remotePath: '/tmp/agentbox-setup-skill.md', remoteMode: 0o644, source: { shared: 'agentbox-setup-skill.md' } },
] as const;

export interface ResolvedAsset extends RuntimeAsset {
  localPath: string;
}

/**
 * Resolve every asset to a concrete host path. Shared assets come from the
 * running CLI (`resolveSharedRuntimeAsset`, which reads `AGENTBOX_CLI_RUNTIME_DIR`
 * and throws when it isn't set — i.e. when not invoked through the CLI); vendored
 * assets come from this package's `scripts/`.
 */
export function resolveRuntimeAssets(): ResolvedAsset[] {
  return RUNTIME_ASSETS.map((asset) => ({
    ...asset,
    localPath:
      'shared' in asset.source
        ? resolveSharedRuntimeAsset(asset.source.shared)
        : vendoredScript(asset.source.vendored),
  }));
}
