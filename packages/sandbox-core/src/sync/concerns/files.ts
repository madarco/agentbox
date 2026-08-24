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
 * expansion, file-vs-dir, exclude, owner/mode defaults, rename-needed,
 * parent-chain-needed). Those live here so the two providers can't drift.
 */

import type { ResolvedCarryEntry } from '@agentbox/core';

/**
 * Hardcoded in-box home — every box runs as a user named `vscode` whose home is
 * this path. Its *uid* is NOT fixed: docker/hetzner/digitalocean/daytona land on
 * 1000, but vercel and e2b `useradd` without `-u` (their base images already
 * hold 1000), so the number is whatever was free when the base was baked. Nothing
 * here may depend on it — see {@link CarryPlan.chownArgs}.
 */
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
  /**
   * argv tokens naming the `chown` target. Default `['--reference=/home/vscode']`
   * — the box user, whatever uid the provider assigned it (see {@link BOX_HOME}).
   * An explicit `user:` gives `['0:0']` / `['33:33']`.
   *
   * `--reference` rather than a name: hetzner/digitalocean may rename an existing
   * uid-1000 account into `vscode` and leave its primary group named `ubuntu`, and
   * a `useradd` without `-u` does not guarantee gid == uid — so the home dir is
   * the only thing that reliably carries both halves of the answer.
   *
   * Contains no shell metacharacters: splice into an argv, or `.join(' ')` into a
   * command string, unquoted.
   */
  chownArgs: string[];
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
   * root-created parent chain must be chowned back with {@link chownArgs}.
   * System paths (`/etc/*`, …) are left untouched.
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
  // Default: whoever owns the box user's home, resolved in-box at chown time.
  // An explicit `user:` stays numeric — `user: 0` lands root:root.
  const chownArgs =
    entry.user === undefined
      ? [`--reference=${BOX_HOME}`]
      : [`${String(entry.user)}:${String(entry.user)}`];
  const mode = entry.mode !== undefined ? entry.mode.toString(8).padStart(4, '0') : undefined;

  const fileBase = isDir ? '' : basenameUnix(entry.absSrc);
  const destBase = isDir ? '' : basenameUnix(boxDest);
  const renameNeeded = !isDir && fileBase !== destBase;

  // `mkdir -p` runs as root, so any new dirs between $HOME and dirname(dest) are
  // root-owned. Only walk when the dest is under $HOME — system paths keep their
  // existing ownership.
  const parentChainNeeded = boxDest.startsWith(`${BOX_HOME}/`) && dirnameUnix(boxDest) !== BOX_HOME;

  return {
    boxDest,
    isDir,
    parentDir,
    exclude,
    chownArgs,
    mode,
    fileBase,
    destBase,
    renameNeeded,
    parentChainNeeded,
  };
}
