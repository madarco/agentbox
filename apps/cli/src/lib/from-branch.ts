/**
 * Host-side validation for `--from-branch <ref>` on `create` / `claude` /
 * `codex` / `opencode` / `code`.
 *
 * The flag tells the provider what base ref to fork the box's per-box branch
 * from instead of the host's current `HEAD`. We validate the ref *here*,
 * before any provider work, so a typo doesn't leave a half-created box.
 *
 * Behavior:
 *   - undefined / empty → no-op, returns undefined.
 *   - SHA-shaped (40-hex prefix, ≥7 chars): skip the fetch (a SHA either
 *     resolves locally or never will; fetching `<remote> <SHA>` isn't a
 *     standard refspec). Validate with `git rev-parse --verify <ref>^{commit}`.
 *   - Otherwise (branch / tag name): run `git fetch <remote> <ref>` best-
 *     effort so a stale clone of `origin/main` still picks up new commits.
 *     Then validate.
 *
 * Returns the ref verbatim on success (the provider passes it to `git
 * worktree add` / `git clone --branch`). Throws with a friendly message on
 * any failure — the caller surfaces it via the usual error path.
 */

import { execa } from 'execa';

const SHA_RE = /^[0-9a-f]{7,40}$/i;

export class FromBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FromBranchError';
  }
}

export interface ResolveFromBranchOpts {
  /** Host repo path; usually the workspace root. Used as `git -C <repo>`. */
  repo: string;
  /** Remote to fetch from for non-SHA refs. Defaults to 'origin'. */
  remote?: string;
}

/**
 * Validate / fetch the requested base ref. Returns the (verbatim) ref so the
 * caller can thread it into `req.fromBranch`. `undefined` input → returns
 * `undefined` without touching git.
 */
export async function resolveFromBranch(
  ref: string | undefined,
  opts: ResolveFromBranchOpts,
): Promise<string | undefined> {
  if (!ref || ref.length === 0) return undefined;
  const remote = opts.remote ?? 'origin';
  const isSha = SHA_RE.test(ref);

  // For branch/tag refs, fetch first so `origin/main` (etc.) reflect the
  // remote's actual tip — boxes started from `--from-branch main` should
  // pick up new commits the user hasn't pulled locally yet.
  if (!isSha) {
    const fetched = await execa(
      'git',
      ['-C', opts.repo, 'fetch', '--quiet', remote, ref],
      { reject: false },
    );
    if (fetched.exitCode !== 0) {
      // Soft-fail: the ref might be local-only (e.g. a private branch) — fall
      // through to the rev-parse check below so we still error clearly when
      // the ref is fully unknown.
    }
  }

  const verify = await execa(
    'git',
    ['-C', opts.repo, 'rev-parse', '--verify', `${ref}^{commit}`],
    { reject: false },
  );
  if (verify.exitCode !== 0) {
    throw new FromBranchError(
      `--from-branch: unknown ref "${ref}" (not found in ${opts.repo} after fetch). ` +
        `Provide a branch, tag, or SHA reachable from the host repo.`,
    );
  }
  return ref;
}
