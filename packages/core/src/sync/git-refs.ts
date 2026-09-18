/**
 * Pure git ref/branch decisions, shared by the relay host paths and the in-box
 * ctl. Lives in `@agentbox/core` (not `sandbox-core`) because `@agentbox/ctl`
 * depends only on core — same pattern as the pure engine in `../replace.ts`.
 *
 * No fs/exec: only string logic. The three git push-back paths (docker relay,
 * cloud relay, in-box lease push) keep their divergent *mechanisms* but read
 * these *decisions* from here so the branch/refspec/remote/upstream spellings
 * can't drift apart.
 */

/** Prefix of the per-box scratch branch (`agentbox/<name>`). */
export const SCRATCH_BRANCH_PREFIX = 'agentbox/';

/**
 * True for a per-box `agentbox/<name>` scratch branch. Undefined-safe so it
 * reproduces the existing `worktree?.branch.startsWith(...) ?? false` sites
 * exactly (`isScratchBranch(undefined) === false`).
 */
export function isScratchBranch(branch: string | undefined): boolean {
  return !!branch && branch.startsWith(SCRATCH_BRANCH_PREFIX);
}

/**
 * True when a push to `branch` is a *sanctioned* push that may bypass the
 * relay's confirm prompt: it's the box's own `agentbox/<name>` scratch branch
 * (always its job), or it exactly matches the branch the host last put the box
 * on (`sanctionedBranch`). An in-box agent that self-switches HEAD to some
 * other branch (e.g. `main`) fails both arms, so its push still prompts.
 * Undefined-safe; empty/`HEAD` never matches the sanctioned arm.
 */
export function isSanctionedPushBranch(
  branch: string | undefined,
  sanctionedBranch: string | undefined,
): boolean {
  if (isScratchBranch(branch)) return true;
  return isResolvedBranch(branch ?? '') && !!sanctionedBranch && branch === sanctionedBranch;
}

/**
 * Resolve the push remote, defaulting to 'origin'.
 *
 * MUST be `??`, not `||`: only an *undefined* remote falls back to 'origin'.
 * A legitimately-empty wire remote must stay '' — `||` would coerce it and
 * silently change the push target.
 */
export function resolveRemote(remote?: string): string {
  return remote ?? 'origin';
}

/**
 * Host-only land destination branch: the requested `as` when non-empty, else
 * the source branch (server.ts `handleGitSaveToHost` ≡ host-actions.ts
 * `runGitRpc` host-only path).
 */
export function resolveLandDest(src: string, as?: string): string {
  return as && as.length > 0 ? as : src;
}

/**
 * Host-only land refspec for `git fetch . <refspec>` (docker) / `git fetch
 * <bundle> <refspec>` (cloud). Force prepends `+` for a non-fast-forward
 * overwrite of the destination branch.
 */
export function landRefspec(src: string, dest: string, force?: boolean): string {
  return `${force ? '+' : ''}${src}:refs/heads/${dest}`;
}

/** Upstream ref for `git branch --set-upstream-to=<remote>/<branch>`. */
export function upstreamRef(remote: string, branch: string): string {
  return `${remote}/${branch}`;
}

/**
 * Remote-tracking ref for the cloud in-box `git update-ref
 * refs/remotes/<remote>/<branch>` (docker shares .git/, so the ref updates
 * during the push and only the upstream config is missing). Kept beside
 * `upstreamRef` to document the two distinct ref shapes side-by-side.
 */
export function remoteTrackingRef(remote: string, branch: string): string {
  return `refs/remotes/${remote}/${branch}`;
}

/**
 * Detached-HEAD guard for a probed branch name (cloud `runGitRpc` resolves the
 * branch via `rev-parse --abbrev-ref HEAD`). NOTE: intentionally NOT used by
 * ctl's weaker `!branch` check — adopting it there would add a `=== 'HEAD'`
 * rejection on the control-plane lease push path (a behavior change).
 */
export function isResolvedBranch(s: string): boolean {
  return s.length > 0 && s !== 'HEAD';
}

/**
 * Filter a user-supplied extra-argv tail down to strings. The argv *prefixes*
 * differ per site (`git -C repo push …` vs `-C repo push …` vs `push …`) and
 * stay site-local; only this trailing arg-filter is shared.
 */
export function sanitizeGitArgs(args: unknown): string[] {
  return Array.isArray(args) ? args.filter((a): a is string => typeof a === 'string') : [];
}

/**
 * Wire params for the `git.push` / `git.fetch` RPCs. Canonical home for the
 * shape that the relay receives and the in-box ctl builds (previously declared
 * independently in `relay/src/types.ts` and `ctl/src/commands/git.ts`).
 */
export interface GitRpcParams {
  /** Container path identifying which worktree to run against. Defaults to /workspace. */
  path?: string;
  /** Remote name; defaults to 'origin'. */
  remote?: string;
  /** Extra argv tail appended after the standard args (e.g. ['--set-upstream', 'origin', 'branch']). */
  args?: string[];
  /**
   * git.push only: land the box's branch in the host's *local* repo instead of
   * pushing to the remote. Nothing is published online; the relay skips the
   * host-initiated-token / confirm-prompt gate (that gate guards remote pushes).
   */
  hostOnly?: boolean;
  /**
   * git.push --host-only only: destination branch name in the host repo.
   * Defaults to the box's current branch name when omitted.
   */
  as?: string;
  /** git.push --host-only only: allow a non-fast-forward overwrite of the destination branch. */
  force?: boolean;
  /**
   * One-time token minted by the host CLI via `/admin/host-initiated/mint`
   * before invoking this RPC through `agentbox-ctl`. The relay validates the
   * token against its in-memory store, scoped to `(boxId, method)`; on
   * match, the token is consumed and the confirm prompt is skipped. Boxes
   * cannot mint these (the admin endpoint is loopback-only), so a malicious
   * agent cannot forge "host-initiated" calls. Invalid/expired tokens fall
   * through to the normal prompt path.
   */
  hostInitiated?: string;
}

/** What a box is allowed to push to, from the host's own records. */
export interface PushTargetPolicy {
  /** The box's create-time branch (`agentbox/<name>`), when the site knows it. */
  branch?: string;
  /** The branch the host last put the box on (`agentbox git checkout`). */
  sanctionedBranch?: string;
}

/**
 * True when `dst` (a bare branch name) is a target the host already sanctions:
 * any `agentbox/*` scratch branch, the box's create-time branch, or the branch
 * the host last checked out for it. Same decision as the gate's own bypass —
 * expressed by reusing `isSanctionedPushBranch` against each known branch.
 */
export function isAllowedPushTarget(dst: string, policy: PushTargetPolicy): boolean {
  return (
    isSanctionedPushBranch(dst, policy.sanctionedBranch) ||
    isSanctionedPushBranch(dst, policy.branch)
  );
}

/**
 * Push flags that cannot add or redirect a ref target. Allowlist: anything not
 * listed — `--all`, `--mirror`, `--tags`, `--follow-tags`, `--delete`/`-d`,
 * `--prune`, `--repo <url>`, `--exec`/`--receive-pack`, `--recurse-submodules`,
 * and every flag git may grow next — refuses, because an unrecognised
 * value-consuming flag would also desync the positional parse below.
 */
const TARGET_NEUTRAL_PUSH_FLAGS = new Set([
  '-f',
  '--force',
  '--force-with-lease',
  '--no-force-with-lease',
  '--force-if-includes',
  '--no-force-if-includes',
  '-u',
  '--set-upstream',
  '-n',
  '--dry-run',
  '--porcelain',
  '-q',
  '--quiet',
  '-v',
  '--verbose',
  '--progress',
  '--no-progress',
  '--atomic',
  '--no-atomic',
  '--verify',
  '--no-verify',
  '--thin',
  '--no-thin',
  '-4',
  '--ipv4',
  '-6',
  '--ipv6',
]);

/**
 * Target-neutral flags whose value rides in the same token (`--flag=value`).
 * `--force-with-lease=<ref>[:<expect>]` names a ref as an *expectation*, never
 * as a destination, so it adds no target.
 */
const TARGET_NEUTRAL_VALUE_FLAGS = new Set(['--force-with-lease']);

/** A branch name we are willing to compare against the policy, spelled plainly. */
const PLAIN_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isPlainBranchName(s: string): boolean {
  return PLAIN_BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
}

/**
 * The branch a push refspec would write on the remote, or null when the token
 * is not a plain branch destination we can reason about (a deletion `:branch`,
 * a non-`refs/heads/` namespace such as `refs/tags/…`, a glob, a negative
 * `^ref`, a remote name mistaken for a refspec …). Null always fails closed.
 */
export function pushRefspecTarget(token: string): string | null {
  let spec = token.startsWith('+') ? token.slice(1) : token;
  const colon = spec.indexOf(':');
  if (colon >= 0) {
    // An empty source (`:branch`) is a DELETE of the remote branch.
    if (colon === 0) return null;
    spec = spec.slice(colon + 1);
  }
  if (spec.startsWith('refs/')) {
    if (!spec.startsWith('refs/heads/')) return null;
    spec = spec.slice('refs/heads/'.length);
  }
  return isPlainBranchName(spec) ? spec : null;
}

/**
 * True when the box-supplied argv tail appended after the relay's own
 * `push <remote> <branch>` writes nothing beyond what the host sanctions.
 *
 * The relay picks the branch it pushes, but git accepts MULTIPLE refspecs, so
 * a tail of `other-branch` or `HEAD:refs/heads/other` silently adds a second
 * destination. The gate's bypass therefore has to hold for every ref the
 * assembled command would write, not just for the one the relay chose.
 *
 * Allowlist, fail-closed: every token must be either a target-neutral flag or
 * a refspec whose destination is an allowed target. An empty tail is allowed.
 */
export function pushArgvTargetsAllowed(args: string[], policy: PushTargetPolicy): boolean {
  let positionalsOnly = false;
  for (const arg of args) {
    if (!positionalsOnly && arg === '--') {
      positionalsOnly = true;
      continue;
    }
    if (!positionalsOnly && arg.length > 1 && arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const known =
        eq < 0
          ? TARGET_NEUTRAL_PUSH_FLAGS.has(arg)
          : TARGET_NEUTRAL_VALUE_FLAGS.has(arg.slice(0, eq));
      if (!known) return false;
      continue;
    }
    // Positional: the relay already supplied the remote, so git reads every
    // one of these as a refspec (a second remote name lands here too, and
    // fails the branch check — which is the fail-closed answer we want).
    const target = pushRefspecTarget(arg);
    if (target === null || !isAllowedPushTarget(target, policy)) return false;
  }
  return true;
}
