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
