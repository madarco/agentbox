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

/**
 * `git push` policy: a blacklist, not an allowlist — the same model, in the
 * same words, as the `gh` policy in `packages/relay/src/gh.ts`. Read the two
 * together: one approval model, two surfaces.
 *
 * A push that merely ADDS commits to a branch — the box's own `agentbox/*`
 * scratch branch, the branch the host put it on, or any other branch the agent
 * names — is ordinary, revertable agent work. It runs silently, to any branch,
 * and does not consult `box.autoApproveSafeHostActions`. Same reasoning that
 * keeps `gh pr merge` off the destructive list: ordinary agent work that can be
 * undone does not deserve a prompt.
 *
 * Only the irreversible is confirmed with the user: {@link pushDestructiveReason}
 * returns a non-null reason for a deletion, a history rewrite of a branch that
 * is not the box's own scratch space, a wholesale ref sync, a tag overwrite, or
 * an argv that escapes the intended remote entirely.
 *
 * The one push-shaped RPC still gated on every call is `git.lease-token`: it
 * hands the box a repo-scoped credential and the box pushes by itself, so the
 * relay never sees an argv for this policy to judge.
 */

/**
 * Flags that are destructive whatever the rest of the argv says, each with the
 * reason shown in the confirm prompt.
 *
 * `--repo` / `--receive-pack` / `--exec` are not destructive in themselves;
 * they are the two ways a push argv leaves its intended target entirely —
 * aiming the host's credentials at another repository, or running a command on
 * the remote side. A gate that cannot tell where a push lands cannot call it
 * ordinary, so they confirm too.
 */
const DESTRUCTIVE_PUSH_FLAGS = new Map<string, string>([
  ['--delete', 'deletes a remote ref'],
  ['-d', 'deletes a remote ref'],
  ['--mirror', 'mirrors local refs, deleting every remote ref that is absent locally'],
  ['--prune', 'deletes remote refs that have no local counterpart'],
  ['--repo', 'redirects the push to another repository, using the host credentials'],
  ['--receive-pack', 'runs a command on the remote side'],
  ['--exec', 'runs a command on the remote side'],
]);

/** History-rewriting force. Judged against the refs the push would write. */
const FORCE_PUSH_FLAGS = new Set(['-f', '--force']);

/** Flags that widen the push to a whole ref set the argv does not enumerate. */
const REF_SET_PUSH_FLAGS = new Set(['--all', '--tags']);

/**
 * Flags that only ever add commits, or change reporting.
 *
 * `--force-with-lease` / `--force-if-includes` are the SAFE force spellings and
 * stay silent on purpose: they refuse to clobber work the pusher has not seen,
 * so the worst they can drop is history the box itself already had.
 *
 * Anything not listed here — including every flag git may grow next — needs
 * confirmation. Failing closed is not pedantry: an unrecognised
 * value-consuming flag would also desync the positional parse below and hide a
 * refspec from it.
 */
const ORDINARY_PUSH_FLAGS = new Set([
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
  '--follow-tags',
  '--signed',
  '--no-signed',
  '--force-with-lease',
  '--no-force-with-lease',
  '--force-if-includes',
  '--no-force-if-includes',
  '-4',
  '--ipv4',
  '-6',
  '--ipv6',
]);

/**
 * Ordinary flags whose value rides in the same token (`--flag=value`).
 * `--force-with-lease=<ref>[:<expect>]` names a ref as an *expectation*, never
 * as a destination.
 */
const ORDINARY_VALUE_FLAGS = new Set(['--force-with-lease', '--signed']);

/** A branch name we are willing to reason about, spelled plainly. */
const PLAIN_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function isPlainBranchName(s: string): boolean {
  return PLAIN_BRANCH.test(s) && !s.includes('..') && !s.endsWith('/') && !s.endsWith('.lock');
}

/**
 * The branch a push refspec would write on the remote, or null when the token
 * is not a plain branch destination we can reason about (a deletion `:branch`,
 * a non-`refs/heads/` namespace such as `refs/tags/…`, a glob, a negative
 * `^ref`, a remote name mistaken for a refspec …). Null is "cannot resolve",
 * which every caller reads as "not the box's own scratch branch".
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
 * Per-refspec verdict. Two irreversible shapes hide in a refspec: an empty
 * source (`:branch`, `+:branch`) deletes the remote ref, and a `+` prefix is
 * `--force` for that one ref.
 *
 * A plain `refs/tags/v1` write is ordinary — it can only create a NEW tag,
 * since git refuses to move an existing one without force. `+refs/tags/v1` and
 * `:refs/tags/v1` are the overwrite and the delete, and both land on the rules
 * below because `pushRefspecTarget` resolves `refs/heads/` destinations only.
 */
function refspecDestructiveReason(token: string): string | null {
  const forced = token.startsWith('+');
  const spec = forced ? token.slice(1) : token;
  if (spec.startsWith(':')) return `deletes the remote ref ${spec.slice(1) || '(unnamed)'}`;
  if (!forced) return null;
  const target = pushRefspecTarget(token);
  return isScratchBranch(target ?? undefined)
    ? null
    : `force-pushes ${target ?? token}, rewriting history the box did not create`;
}

/**
 * Why this push needs the user's confirmation, or null when it is ordinary
 * work that runs silently.
 *
 * `pushedBranch` is the branch the relay itself puts on the command line
 * (docker: the worktree's sanctioned branch; cloud: the box's HEAD); the box's
 * argv tail is appended after it, and git accepts several refspecs, so a force
 * flag is judged against that branch AND every ref the tail names. An
 * unregistered `pushedBranch` counts as non-scratch: fail closed.
 */
export function pushDestructiveReason(
  args: readonly string[],
  pushedBranch?: string,
): string | null {
  const targets: { label: string; scratch: boolean }[] = [
    { label: pushedBranch ?? '(unregistered branch)', scratch: isScratchBranch(pushedBranch) },
  ];
  let positionalsOnly = false;
  let force = false;
  let refSetFlag: string | null = null;

  for (const arg of args) {
    if (!positionalsOnly && arg === '--') {
      positionalsOnly = true;
      continue;
    }
    if (!positionalsOnly && arg.length > 1 && arg.startsWith('-')) {
      const eq = arg.indexOf('=');
      const name = eq < 0 ? arg : arg.slice(0, eq);
      const destructive = DESTRUCTIVE_PUSH_FLAGS.get(name);
      if (destructive) return destructive;
      if (FORCE_PUSH_FLAGS.has(name)) {
        force = true;
        continue;
      }
      if (REF_SET_PUSH_FLAGS.has(name)) {
        refSetFlag = name;
        continue;
      }
      const known = eq < 0 ? ORDINARY_PUSH_FLAGS.has(arg) : ORDINARY_VALUE_FLAGS.has(name);
      if (!known) return `uses ${arg}, a push flag this gate does not recognise`;
      continue;
    }
    // Positional: the relay already supplied the remote, so git reads every one
    // of these as a refspec (a second remote name lands here too, and resolves
    // to a non-scratch target — the fail-closed answer we want under force).
    const reason = refspecDestructiveReason(arg);
    if (reason) return reason;
    const target = pushRefspecTarget(arg);
    targets.push({ label: target ?? arg, scratch: isScratchBranch(target ?? undefined) });
  }

  if (force) {
    // `--force --tags` / `--force --all` rewrite refs the argv never names, so
    // no per-target check can clear them.
    if (refSetFlag) return `force-pushes every ref selected by ${refSetFlag}`;
    const rewritten = targets.filter((t) => !t.scratch).map((t) => t.label);
    if (rewritten.length > 0) {
      return `force-pushes ${rewritten.join(', ')}, rewriting history the box did not create`;
    }
  }
  return null;
}
