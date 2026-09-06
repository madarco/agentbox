/**
 * How a registered provider plugin got onto this machine — which decides whether
 * `self-update` may replace it, and with which package manager.
 *
 * There is no `source` field on `PluginRecord` recording this, and adding one
 * would need `PLUGINS_FILE_VERSION` 3 — which every older reader degrades to an
 * EMPTY registry (`isKnownVersion` accepts only 1|2), so an older CLI or a
 * control box sharing ~/.agentbox would suddenly see zero plugins. It is cheaper
 * and safer to recompute, especially since "which manager do I invoke" needs the
 * global roots anyway.
 */

import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';

export interface GlobalRoots {
  npm: string | null;
  pnpm: string | null;
}

export type PluginInstallKind =
  | { kind: 'npm' }
  | { kind: 'pnpm' }
  /** Registered from a directory the user owns — nothing to npm-update. */
  | { kind: 'path' }
  /** `npm link`ed dev checkout: looks global, but replacing it detaches the dev. */
  | { kind: 'linked' }
  /** Could not be resolved at all any more (uninstalled, or an nvm version switch). */
  | { kind: 'missing' };

function rootOf(cmd: string): string | null {
  try {
    const out = execFileSync(cmd, ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    // Not installed, or offline in a way that makes it exit non-zero. Absent is
    // a fine answer — it just means "no package is managed by this one".
    return null;
  }
}

export function readGlobalRoots(): GlobalRoots {
  return { npm: rootOf('npm'), pnpm: rootOf('pnpm') };
}

function safeRealpath(p: string, realpath: (p: string) => string): string | null {
  try {
    return realpath(p);
  } catch {
    return null;
  }
}

/** True when `child` is `parent` or sits underneath it. Both must be realpaths. */
function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent + sep);
}

/**
 * Pure given its injected realpath, so it is testable against a tmpdir fake root
 * without shelling out to a package manager.
 *
 * The `linked` test is NOT "is `<root>/<pkg>` a symlink" — pnpm-global installs
 * are symlinks too, into `.pnpm/<pkg>@<v>/node_modules/<pkg>`, so that test
 * classifies every pnpm plugin as a dev checkout and silently stops updating it.
 * What actually separates the two is whether the link ESCAPES the manager's own
 * install tree: pnpm's store lives beside its `node_modules`, while `npm link`
 * points at a working tree somewhere else entirely.
 */
export function classifyPluginInstall(args: {
  packageName: string;
  /** FRESHLY resolved entry, or null when resolution failed. Never the stored one. */
  resolvedEntry: string | null;
  roots: GlobalRoots;
  realpath?: (p: string) => string;
}): PluginInstallKind {
  const { packageName, resolvedEntry, roots, realpath = realpathSync } = args;

  if (resolvedEntry === null) return { kind: 'missing' };
  const entryReal = safeRealpath(resolvedEntry, realpath);
  if (entryReal === null) return { kind: 'missing' };

  const managed: [Extract<PluginInstallKind['kind'], 'npm' | 'pnpm'>, string | null][] = [
    ['npm', roots.npm],
    ['pnpm', roots.pnpm],
  ];

  for (const [manager, root] of managed) {
    if (root === null) continue;
    const dirReal = safeRealpath(join(root, packageName), realpath);
    if (dirReal === null) continue;
    if (!within(entryReal, dirReal)) continue;

    // `dirname(root)` is the manager's install tree: `<prefix>/lib` for npm,
    // `<pnpm-global>/<n>` for pnpm — which contains both `node_modules` and the
    // `.pnpm` store a pnpm symlink resolves into.
    const treeReal = safeRealpath(dirname(root), realpath);
    if (treeReal !== null && !within(dirReal, treeReal)) return { kind: 'linked' };
    return { kind: manager };
  }

  return { kind: 'path' };
}
