/**
 * Source-checkout detection shared by the install commands.
 *
 * The CLI is bundled to `<root>/dist/index.js`; `share/` ships as a sibling of
 * `dist/` in both the dev tree and the published package. We key dev-vs-published
 * decisions on the *location* of that bundled `share/host-skills` dir: every
 * distribution path (`npm i -g`, pnpm global, the npx cache) lives under a
 * `node_modules` segment, a dev clone does not. In a checkout we symlink skills
 * so source edits are picked up live; a published install must copy.
 */

import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Locate the bundled `share/host-skills/` directory. This module is bundled into
 * the CLI; `share/` is a sibling of `dist/` in both the dev tree and the
 * published package. The src-tree candidate covers running unbundled (e.g. tsx).
 */
export function resolveHostSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(here, '..', 'share', 'host-skills'),
    resolve(here, '..', '..', 'share', 'host-skills'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  throw new Error(`could not locate bundled host skills; tried:\n  ${candidates.join('\n  ')}`);
}

/**
 * True when the bundled skills resolve inside a source checkout rather than an
 * installed package. We key on the source *location*, not `detectExecutionMethod`,
 * because a global install invoked directly carries no `npm_config_user_agent` and
 * would misreport as `direct`.
 */
export function isSourceCheckout(srcDir: string): boolean {
  return !srcDir.split(sep).includes('node_modules');
}

/**
 * The repo root when running from a source checkout that still carries the Codex
 * marketplace sources, else `null`. The published npm package ships `share/` but
 * NOT `plugins/` or `.agents/`, so this returns `null` for any real install — the
 * Codex installer falls back to the GitHub marketplace there. `resolveHostSkillsDir`
 * returns `<root>/apps/cli/share/host-skills`; the repo root is four levels up.
 */
export function resolveDevRepoRoot(): string | null {
  let hostSkillsDir: string;
  try {
    hostSkillsDir = resolveHostSkillsDir();
  } catch {
    return null;
  }
  if (!isSourceCheckout(hostSkillsDir)) return null;
  const root = resolve(hostSkillsDir, '..', '..', '..', '..');
  const hasMarketplace = existsSync(join(root, '.agents', 'plugins', 'marketplace.json'));
  const hasPlugin = existsSync(join(root, 'plugins', 'agentbox'));
  return hasMarketplace && hasPlugin ? root : null;
}
