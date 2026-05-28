/**
 * Host-side validation for `--from-branch <ref>` and `--use-branch <name>`
 * on `create` / `claude` / `codex` / `opencode` / `code`.
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

export class UseBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UseBranchError';
  }
}

/**
 * Host-side validation for `--use-branch <name>`. Unlike `--from-branch`
 * (which only picks a *base ref* to fork a fresh `agentbox/<box>` branch
 * from), `--use-branch` checks out the existing branch directly — so we
 * require a real local **branch** ref, not a tag or detached SHA. A box that
 * checks out a detached ref has nowhere to `git push`, so those are rejected.
 *
 * Best-effort `git fetch <remote> <name>` first so the branch tracks the
 * remote tip (the cloud bundle is built from the host's local ref state).
 * Returns the name verbatim on success; throws `UseBranchError` otherwise.
 * `undefined` / empty input → returns `undefined` without touching git.
 */
export async function resolveUseBranch(
  name: string | undefined,
  opts: ResolveFromBranchOpts,
): Promise<string | undefined> {
  if (!name || name.length === 0) return undefined;
  const remote = opts.remote ?? 'origin';

  // Update the local branch to the remote tip when possible. Soft-fail: the
  // branch may be local-only, in which case the show-ref check below still
  // passes against the existing local ref.
  await execa('git', ['-C', opts.repo, 'fetch', '--quiet', remote, name], {
    reject: false,
  });

  const exists = await execa(
    'git',
    ['-C', opts.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${name}`],
    { reject: false },
  );
  if (exists.exitCode !== 0) {
    throw new UseBranchError(
      `--use-branch: no local branch "${name}" in ${opts.repo}. ` +
        `Create or check it out on the host first (--use-branch reuses an ` +
        `existing branch; use --from-branch to fork a new box branch from a ref).`,
    );
  }
  return name;
}

/**
 * The host workspace's current branch name (`git rev-parse --abbrev-ref
 * HEAD`). Returns `undefined` when HEAD is detached (git prints the literal
 * `HEAD`) or when the command fails. Used by the `cloud.useCurrentBranch`
 * config path to default cloud boxes onto the host's current branch.
 */
export async function currentHostBranch(repo: string): Promise<string | undefined> {
  const r = await execa('git', ['-C', repo, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    reject: false,
  });
  if (r.exitCode !== 0) return undefined;
  const branch = r.stdout.trim();
  if (!branch || branch === 'HEAD') return undefined;
  return branch;
}

export interface BranchSelectionOpts {
  /** Raw `--use-branch <name>` value (undefined when not passed). */
  useBranch?: string;
  /** Raw `--from-branch <ref>` value (undefined when not passed). */
  fromBranch?: string;
  /** Host repo path (the workspace root). */
  repo: string;
  /** Provider the box will be created on; gates the cloud.useCurrentBranch default. */
  providerName: string;
  /** `cfg.effective.cloud.useCurrentBranch`. */
  cloudUseCurrentBranch: boolean;
  /** Optional logger for informational notes (e.g. detached-HEAD fallback). */
  log?: (msg: string) => void;
}

/**
 * Resolve the box's branch strategy from the two flags plus the
 * `cloud.useCurrentBranch` config. Single source of truth shared by
 * `create` / `claude` / `codex` / `opencode` so the mutex + precedence stay
 * identical across commands.
 *
 * Precedence: `--use-branch` > `--from-branch` > (cloud only)
 * `cloud.useCurrentBranch` > default fork. Throws `UseBranchError` on the
 * mutex conflict or an invalid `--use-branch`, `FromBranchError` on an
 * invalid `--from-branch`; callers catch both and exit before provider work.
 */
export async function resolveBranchSelection(
  opts: BranchSelectionOpts,
): Promise<{ useBranch?: string; fromBranch?: string }> {
  if (opts.useBranch && opts.fromBranch) {
    throw new UseBranchError(
      '--use-branch and --from-branch are mutually exclusive: --use-branch reuses an ' +
        'existing branch, --from-branch forks a new box branch from a base ref. Pass only one.',
    );
  }
  if (opts.useBranch) {
    return { useBranch: await resolveUseBranch(opts.useBranch, { repo: opts.repo }) };
  }
  if (opts.fromBranch) {
    return { fromBranch: await resolveFromBranch(opts.fromBranch, { repo: opts.repo }) };
  }
  // cloud.useCurrentBranch defaults cloud boxes onto the host's current
  // branch. Docker can't reuse it (the host already has it checked out → a
  // worktree-registry collision), so this only fires for cloud providers.
  if (opts.providerName !== 'docker' && opts.cloudUseCurrentBranch) {
    const current = await currentHostBranch(opts.repo);
    if (current) {
      opts.log?.(`cloud.useCurrentBranch: starting box on host branch "${current}"`);
      return { useBranch: current };
    }
    opts.log?.(
      'cloud.useCurrentBranch is set but host HEAD is detached; forking a fresh branch instead',
    );
  }
  return {};
}
