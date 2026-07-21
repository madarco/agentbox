/**
 * Access to the provider-NEUTRAL box-side runtime assets (`ctl.cjs`, shims,
 * dockerd/vnc start scripts, managed settings) that the running AgentBox CLI
 * stages under `runtime/_shared/`.
 *
 * A VPS-style plugin (one that bakes a base snapshot by installing files onto a
 * throwaway host) ships only its OWN provider-specific pieces (an install
 * script, a system prompt) and pulls the neutral ones from here — so it always
 * installs the *running CLI's* `ctl.cjs`, version-locked to the CLI rather than
 * to whatever the plugin bundled. Providers that build from a Dockerfile don't
 * need this.
 *
 * The CLI stamps its staged runtime root into `AGENTBOX_CLI_RUNTIME_DIR` at
 * startup; this resolver reads `<root>/_shared/<basename>`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Env var the AgentBox CLI sets to its staged `runtime/` root at startup. */
export const CLI_RUNTIME_DIR_ENV = 'AGENTBOX_CLI_RUNTIME_DIR';

/** Basenames the CLI stages under `runtime/_shared/` (kept in sync with stage-runtime.mjs). */
export const SHARED_RUNTIME_ASSETS = [
  'ctl.cjs',
  'agentbox-vnc-start',
  'agentbox-dockerd-start',
  'agentbox-portless-trust',
  'agentbox-checkpoint-cleanup',
  'agentbox-open',
  'gh-shim',
  'git-shim',
  'ntn-shim',
  'linear-shim',
  'claude-managed-settings.json',
  'agentbox-codex-hooks.json',
  'opencode-agentbox-plugin.js',
  'agentbox-setup-skill.md',
] as const;

export type SharedRuntimeAsset = (typeof SHARED_RUNTIME_ASSETS)[number];

/** Directory the running CLI staged its shared assets under, or null if unset/missing. */
export function sharedRuntimeDir(): string | null {
  const root = process.env[CLI_RUNTIME_DIR_ENV];
  if (!root) return null;
  const dir = join(root, '_shared');
  return existsSync(dir) ? dir : null;
}

/**
 * Absolute host path to a shared runtime asset (e.g. `ctl.cjs`), resolved from
 * the running CLI's staged `runtime/_shared/`. Throws an actionable error when
 * the CLI didn't stamp `AGENTBOX_CLI_RUNTIME_DIR` (e.g. the plugin was invoked
 * outside AgentBox) or the asset is missing.
 */
export function resolveSharedRuntimeAsset(basename: string): string {
  const dir = sharedRuntimeDir();
  if (!dir) {
    throw new Error(
      `cannot resolve shared runtime asset "${basename}": ${CLI_RUNTIME_DIR_ENV} is not set — this provider must run under the AgentBox CLI (which stages ctl.cjs + shims and stamps that env var).`,
    );
  }
  const p = join(dir, basename);
  if (!existsSync(p)) {
    throw new Error(
      `shared runtime asset "${basename}" not found under ${dir} — your AgentBox CLI may be too old for this provider.`,
    );
  }
  return p;
}
