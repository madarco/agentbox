/**
 * Concern: files (`carry:` block from `agentbox.yaml`) copied host→box to
 * declared destinations that may live anywhere in the box (not constrained to
 * /workspace).
 *
 * carry is the most provider-divergent concern, so this module deliberately
 * unifies only the *decision* logic — the pure `planCarryEntry` below — and
 * leaves each provider's *apply* mechanism byte-identical:
 *  - docker `copyOneEntry` (`sandbox-docker/host-export.ts`): `streamTarPipe`
 *    (stdin, no temp file) + separate `docker exec --user 0:0` calls.
 *  - cloud `uploadOneEntry` (`sandbox-cloud/carry.ts`): a staged temp tar +
 *    `uploadFile` + ONE combined bash command (splitting/nesting it reintroduces
 *    a Vercel `$(...)`/`while` hang — see the note in that file).
 *
 * Both apply paths share the same up-front decisions (`~/`→`/home/vscode`
 * expansion, file-vs-dir, exclude, uid/mode defaults, rename-needed,
 * parent-chain-needed). Those live here so the two providers can't drift.
 */

import type { ResolvedCarryEntry } from '@agentbox/core';

/** Hardcoded in-box home — boxes always run as the `vscode` user (uid 1000). */
export const BOX_HOME = '/home/vscode';

/** dirname() that always uses '/' regardless of host OS (the box is linux). */
export function dirnameUnix(p: string): string {
  const i = p.lastIndexOf('/');
  if (i <= 0) return '/';
  return p.slice(0, i);
}

/** basename() that always uses '/' regardless of host OS (the box is linux). */
export function basenameUnix(p: string): string {
  const i = p.lastIndexOf('/');
  return i < 0 ? p : p.slice(i + 1);
}

/**
 * The shared, byte-for-byte carry decisions both providers apply. Everything
 * here is a pure function of the entry; nothing touches the host FS or the box.
 */
export interface CarryPlan {
  /** `absDest` with `~/` expanded to `/home/vscode` (host-side, never in-box). */
  boxDest: string;
  /** True for a `dir` entry, false for a `file` entry. */
  isDir: boolean;
  /**
   * Dir to `mkdir -p` before extracting: the dest itself for a dir, the dest's
   * parent for a file. Trailing slashes on the dest are stripped first.
   */
  parentDir: string;
  /** tar `--exclude` patterns (dir entries only; empty for files). */
  exclude: string[];
  /** chown target uid:uid inside the box. Default 1000 (`vscode`); 0 = root. */
  uid: number;
  /** Zero-padded octal `chmod -R` arg, or undefined when no mode is set. */
  mode?: string;
  /** Source basename inside the packed tar (file entries only; '' for dirs). */
  fileBase: string;
  /** Dest basename (file entries only; '' for dirs). */
  destBase: string;
  /** File dest basename differs from the source → `mv` after extract. */
  renameNeeded: boolean;
  /**
   * Dest is under `$HOME` with a non-`$HOME` immediate parent, so the
   * root-created parent chain must be chowned back to `uid`. System paths
   * (`/etc/*`, …) are left untouched.
   */
  parentChainNeeded: boolean;
}

/**
 * Compute the shared carry decisions for one entry. Returns `null` for a
 * `missing` (optional + absent-on-host) entry, which both providers skip.
 */
export function planCarryEntry(entry: ResolvedCarryEntry): CarryPlan | null {
  if (entry.kind === 'missing') return null;

  // ~/ expands to /home/vscode at this layer (host-side), NOT inside the box's
  // shell — so we never depend on the executing user's $HOME (which is /root
  // when the docker path runs `--user 0:0`).
  const boxDest = entry.absDest.startsWith('~/')
    ? `${BOX_HOME}/${entry.absDest.slice(2)}`
    : entry.absDest;
  const boxDestNoSlash = boxDest.endsWith('/') ? boxDest.slice(0, -1) : boxDest;

  const isDir = entry.kind === 'dir';
  const parentDir = isDir ? boxDestNoSlash : dirnameUnix(boxDestNoSlash);
  const exclude = isDir ? (entry.exclude ?? []) : [];
  // Default uid 1000 (in-box vscode); explicit `user: 0` lands root:root.
  const uid = entry.user ?? 1000;
  const mode = entry.mode !== undefined ? entry.mode.toString(8).padStart(4, '0') : undefined;

  const fileBase = isDir ? '' : basenameUnix(entry.absSrc);
  const destBase = isDir ? '' : basenameUnix(boxDest);
  const renameNeeded = !isDir && fileBase !== destBase;

  // `mkdir -p` runs as root, so any new dirs between $HOME and dirname(dest) are
  // root-owned. Only walk when the dest is under $HOME — system paths keep their
  // existing ownership.
  const parentChainNeeded =
    boxDest.startsWith(`${BOX_HOME}/`) && dirnameUnix(boxDest) !== BOX_HOME;

  return {
    boxDest,
    isDir,
    parentDir,
    exclude,
    uid,
    mode,
    fileBase,
    destBase,
    renameNeeded,
    parentChainNeeded,
  };
}
