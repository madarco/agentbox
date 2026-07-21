/**
 * Provider-agnostic box git + service-control helpers, shared by the host CLI
 * (`agentbox git …` / `agentbox services …`) and the hub backend so the argv and
 * RPC-param contracts never drift between the two frontends.
 *
 * Credentialed git RPCs (push / pull-fetch) carry a one-time host-initiated
 * token; minting is a relay concern, so the caller injects it via
 * `deps.hostInitiatedArgs`. Keeping the mint out of this module is deliberate:
 * `@agentbox/relay` depends on `@agentbox/sandbox-core`, so this package must not
 * reach back to relay/ctl (that would be a dependency cycle).
 *
 * The predicted `GitRpcParams` built here MUST match, byte-for-byte, what the
 * in-box `agentbox-ctl git` sends, or the relay's params-hash binding rejects
 * the minted token. This mirrors `buildParams` in `packages/ctl/src/commands/git.ts`.
 */
import type { BoxRecord, ExecResult, GitRpcParams, Provider } from '@agentbox/core';
import { isScratchBranch, SCRATCH_BRANCH_PREFIX } from '@agentbox/core';

/** The box workspace is always mounted here; ctl mirrors `process.cwd()` into `params.path`. */
export const BOX_WORKSPACE = '/workspace';

/**
 * Mint a `--host-initiated-token <tok>` argv fragment bound to a git RPC's
 * `(method, params)`. Returns `[]` when no token could be minted — the call
 * still proceeds through the relay's normal prompt path (and `agentbox/*`
 * scratch pushes auto-allow with no prompt regardless).
 */
export type HostInitiatedArgs = (method: string, params: GitRpcParams) => Promise<string[]>;

export interface BoxGitDeps {
  hostInitiatedArgs?: HostInitiatedArgs;
}

function run(provider: Provider, box: BoxRecord, argv: string[]): Promise<ExecResult> {
  return provider.exec(box, argv, { cwd: BOX_WORKSPACE });
}

/** Normalize a user-supplied name to an `agentbox/<name>` scratch branch (idempotent). */
export function scratchBranchName(name: string): string {
  const trimmed = name.trim();
  return isScratchBranch(trimmed) ? trimmed : `${SCRATCH_BRANCH_PREFIX}${trimmed}`;
}

/** `git checkout <branch>` — switch the box's worktree. No relay: local to the worktree. */
export function boxGitCheckout(
  provider: Provider,
  box: BoxRecord,
  branch: string,
  extraArgs: string[] = [],
): Promise<ExecResult> {
  return run(provider, box, ['git', 'checkout', branch, ...extraArgs]);
}

/**
 * `git checkout -b agentbox/<name> [from]` — create AND switch onto a fresh
 * scratch branch (from HEAD by default, or the given base ref). Local to the
 * worktree; for docker the branch lands in the bind-mounted host `.git/`
 * immediately, for cloud it stays in-box until pushed to the host.
 */
export function boxGitNewBranch(
  provider: Provider,
  box: BoxRecord,
  name: string,
  from?: string,
): Promise<ExecResult> {
  const argv = ['git', 'checkout', '-b', scratchBranchName(name)];
  if (from && from.trim()) argv.push(from.trim());
  return run(provider, box, argv);
}

/** Build the `{ path, remote?, args? }` ctl sends for a git.push / git.fetch RPC. */
function gitRpcParams(remote: string | undefined, extraArgs: string[]): GitRpcParams {
  const params: GitRpcParams = { path: BOX_WORKSPACE };
  if (remote) params.remote = remote;
  if (extraArgs.length > 0) params.args = extraArgs;
  return params;
}

/** `agentbox-ctl git push` — push the box's branch to the remote via the host relay. */
export async function boxGitPush(
  provider: Provider,
  box: BoxRecord,
  opts: { remote?: string; force?: boolean; args?: string[] },
  deps: BoxGitDeps = {},
): Promise<ExecResult> {
  // `--force` is a real remote-push flag; ctl normalizes it back onto the args
  // tail, so it must be part of the predicted params hash (force last, matching
  // the host CLI).
  const extraArgs = [...(opts.args ?? []), ...(opts.force ? ['--force'] : [])];
  const params = gitRpcParams(opts.remote, extraArgs);
  const tokenArgs = deps.hostInitiatedArgs ? await deps.hostInitiatedArgs('git.push', params) : [];
  const argv = ['agentbox-ctl', 'git', 'push', ...tokenArgs];
  if (opts.remote) argv.push('--remote', opts.remote);
  argv.push(...extraArgs);
  return run(provider, box, argv);
}

/**
 * `agentbox-ctl git pull` — fetch via the relay then merge in /workspace. Only
 * `git.fetch` crosses the relay (the merge is local, no creds), so the token is
 * scoped to `git.fetch`. `--ff-only` is consumed by ctl (not forwarded to the
 * relay) so it stays out of the predicted params hash.
 */
export async function boxGitPull(
  provider: Provider,
  box: BoxRecord,
  opts: { remote?: string; ffOnly?: boolean; args?: string[] },
  deps: BoxGitDeps = {},
): Promise<ExecResult> {
  const extraArgs = opts.args ?? [];
  const params = gitRpcParams(opts.remote, extraArgs);
  const tokenArgs = deps.hostInitiatedArgs ? await deps.hostInitiatedArgs('git.fetch', params) : [];
  const argv = ['agentbox-ctl', 'git', 'pull', ...tokenArgs];
  if (opts.remote) argv.push('--remote', opts.remote);
  if (opts.ffOnly) argv.push('--ff-only');
  argv.push(...extraArgs);
  return run(provider, box, argv);
}

/**
 * `agentbox-ctl git push --host-only` — land the box's branch in the host's
 * *local* repo, publishing nothing. The relay skips its confirm/token gate
 * (that gate guards remote pushes), so no host-initiated token is needed.
 */
export function boxGitPushHost(
  provider: Provider,
  box: BoxRecord,
  opts: { as?: string; force?: boolean; args?: string[] } = {},
): Promise<ExecResult> {
  const argv = ['agentbox-ctl', 'git', 'push', '--host-only'];
  if (opts.as) argv.push('--as', opts.as);
  if (opts.force) argv.push('--force');
  argv.push(...(opts.args ?? []));
  return run(provider, box, argv);
}

// ── service control (in-box supervisor) ──
// The argv is single-sourced here; parsing the `--json` StatusReply stays in the
// callers (they can import `@agentbox/ctl`; this module can't — cycle, see above).

/** `agentbox-ctl status --json` — dump the live task/service/port snapshot. */
export function servicesStatusArgv(): string[] {
  return ['agentbox-ctl', 'status', '--json'];
}

/** Run the live status pull and return the raw exec result (caller parses stdout). */
export function boxServicesStatusRaw(provider: Provider, box: BoxRecord): Promise<ExecResult> {
  return run(provider, box, servicesStatusArgv());
}

/** `agentbox-ctl restart <name>` — restart one supervised service. */
export function restartServiceArgv(name: string): string[] {
  return ['agentbox-ctl', 'restart', name];
}

/** Restart a single supervised service by name. */
export function boxRestartService(provider: Provider, box: BoxRecord, name: string): Promise<ExecResult> {
  return run(provider, box, restartServiceArgv(name));
}

/**
 * Restart every named service in sequence (host-side loop — no in-box wire op,
 * so it works on already-baked boxes). Returns each service's exec result so the
 * caller can report partial failures. Sequential (not parallel) to keep the box
 * from thrashing when services depend on one another.
 */
export async function boxRestartServices(
  provider: Provider,
  box: BoxRecord,
  names: string[],
): Promise<{ name: string; result: ExecResult }[]> {
  const out: { name: string; result: ExecResult }[] = [];
  for (const name of names) {
    out.push({ name, result: await boxRestartService(provider, box, name) });
  }
  return out;
}
