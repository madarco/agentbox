/**
 * Host-side path-containment + secret-file guards for the relay's auto-approve
 * decisions. Unlike its pure sibling `files.ts`, this module DOES touch the
 * filesystem (`realpath`) — that's the whole point: following symlinks is what
 * catches an in-project symlink that actually points outside the box's project
 * folder. Lives in `@agentbox/core` so the relay (`@agentbox/relay`) and the
 * host CLI's carry resolver (`apps/cli`) share one containment definition.
 *
 * These are advisory *safety* checks for relaxing approval prompts, never the
 * only boundary: a not-contained / secret path just falls back to prompting.
 */

import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, normalize, resolve, sep } from 'node:path';

/** realpath `p`, falling back to a lexical resolve when it can't be canonicalized. */
export async function realpathSafe(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return resolve(p);
  }
}

/**
 * True when canonicalized `child` is `parent` or lives under it. Both are
 * resolved so the comparison happens in the same (already realpath'd) space —
 * callers pass values that have been through `realpathSafe`.
 */
export function isInside(child: string, parent: string): boolean {
  const c = resolve(child);
  const p = resolve(parent);
  if (c === p) return true;
  return c.startsWith(p + sep);
}

/**
 * realpath the deepest *existing* prefix of `p`, then re-append the
 * not-yet-existing tail. Lets a download/cp destination that doesn't exist yet
 * still be containment-checked (its existing parent is canonicalized, so a
 * symlinked parent pointing outside is caught), while a fully-existing source
 * is realpath'd end-to-end.
 */
async function realpathDeepestExisting(p: string): Promise<string> {
  let cur = resolve(p);
  const tail: string[] = [];
  // Bounded by the path depth; dirname() reaches the root fixpoint.
  for (;;) {
    try {
      const real = await realpath(cur);
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return resolve(p);
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // nothing along the path exists
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * True when `hostPath` (an absolute host path) resolves to a location inside
 * the box's `workspacePath` (the host dir mirroring `/workspace`). Symlinks are
 * followed via realpath so an in-project link escaping the folder fails the
 * check. A literal `..` that survives normalization is rejected outright.
 * Returns `false` (→ caller prompts) when the workspace is unknown.
 */
export async function isContainedInWorkspace(
  hostPath: string,
  workspacePath: string | undefined,
): Promise<boolean> {
  if (!workspacePath) return false;
  if (!isAbsolute(hostPath)) return false;
  // A surviving `..` segment means the literal path escapes upward.
  if (normalize(hostPath).split(sep).includes('..')) return false;
  const wsReal = await realpathSafe(workspacePath);
  const real = await realpathDeepestExisting(hostPath);
  return isInside(real, wsReal);
}

/** Sensitive directory names: any path segment equal to one of these is secret. */
const SECRET_DIR_SEGMENTS = new Set(['.ssh', '.aws', '.gnupg']);

/** Exact basenames that are always secrets. */
const SECRET_BASENAMES = new Set(['credentials', '.npmrc', '.netrc', '.pgpass', '.htpasswd']);

/** Basename patterns that mark a likely secret / private key. */
const SECRET_BASENAME_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/, // .env, .env.local, .env.production
  /\.(pem|key|pfx|p12|keystore|jks)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/, // private SSH keys (not the .pub)
];

/**
 * True when `hostPath` looks like a secret/credential file — used to keep a
 * host->box copy of such a file behind the approval prompt even when the path
 * is contained. Deliberately conservative (a false positive just re-adds a
 * prompt the user can approve): matches secret dirs, `.config/gh`, exact
 * credential basenames, and private-key patterns.
 */
export function looksLikeSecret(hostPath: string): boolean {
  const segs = normalize(hostPath).split(sep).filter(Boolean);
  for (const seg of segs) {
    if (SECRET_DIR_SEGMENTS.has(seg)) return true;
  }
  // `.config/gh` (gh CLI auth) — two adjacent segments.
  for (let i = 0; i + 1 < segs.length; i++) {
    if (segs[i] === '.config' && segs[i + 1] === 'gh') return true;
  }
  const base = basename(hostPath);
  if (SECRET_BASENAMES.has(base)) return true;
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(base));
}
