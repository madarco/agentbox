import type { BoxRecord, ExecResult } from '@agentbox/core';
import { GH_PR_OPS, hashRpcParams, injectPrCreateHead as injectHead, type GhPrOp } from '@agentbox/relay';
import {
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  mutateState,
  scratchBranchName,
  type BoxGitDeps,
} from '@agentbox/sandbox-core';
import { mintHostInitiatedToken, registerBoxWithRelay } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

/**
 * `agentbox git <subcommand> <box>` — host-side proxy for git/PR operations
 * against a specific box. Every subcommand resolves the box, attaches the
 * provider, and runs the matching `agentbox-ctl git` / `agentbox-ctl gh pr`
 * (or raw `git`) inside the box's /workspace.
 *
 * Credentialed RPCs (push, fetch, pull-fetch, gh pr) carry a one-time scoped
 * token minted by the host via `mintHostInitiatedToken`; the relay validates
 * the token and skips its confirm prompt on match. A simple "host-initiated"
 * boolean would be forgeable by the box agent (the agent sees the argv); the
 * one-time token isn't (the mint endpoint is loopback-only). If the relay
 * can't mint (older relay / not running), the call still proceeds — it just
 * goes through the normal prompt path on the wrapper side.
 */

const WORKSPACE = '/workspace';
/** Generous TTL: a slow push over a flaky uplink can easily take 60s. */
const TOKEN_TTL_MS = 120_000;

async function runInBox(box: BoxRecord, argv: string[]): Promise<ExecResult> {
  const provider = await providerForBox(box);
  return provider.exec(box, argv, { cwd: WORKSPACE });
}

async function runAndStream(box: BoxRecord, argv: string[]): Promise<number> {
  const r = await runInBox(box, argv);
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return r.exitCode;
}

/**
 * Record `branch` as the box's host-sanctioned branch after a host-driven
 * `agentbox git checkout`/`branch`/`pull <branch>`. The relay auto-approves a
 * push only to a scratch branch or this value, so a host branch switch must
 * update it (otherwise the box would prompt to push the branch the host just
 * put it on). Persists to `~/.agentbox/state.json` (docker root worktree +
 * cloud field) and re-registers docker boxes so the in-memory relay registry
 * picks up the new value. Best-effort: a failure here just means the next push
 * to that branch prompts — it never blocks the branch switch itself.
 */
async function sanctionBoxBranch(box: BoxRecord, branch: string): Promise<void> {
  try {
    await mutateState((state) => {
      const b = state.boxes.find((x) => x.id === box.id);
      if (!b) return state;
      if (b.gitWorktrees) {
        for (const w of b.gitWorktrees) {
          if (w.kind === 'root') w.sanctionedBranch = branch;
        }
      }
      if (b.cloud) b.cloud.sanctionedBranch = branch;
      return state;
    });
  } catch {
    return; // couldn't persist → leave the gate as-is
  }
  // Docker's push gate reads the in-memory registry, so re-register to refresh
  // the worktree's sanctionedBranch. Cloud's gate reads state.json per RPC, so
  // the persist above is enough — no cloud re-register needed.
  const isDocker = box.provider === 'docker' || box.provider === undefined;
  if (isDocker && box.relayToken) {
    const worktrees = (box.gitWorktrees ?? []).map((w) =>
      w.kind === 'root' ? { ...w, sanctionedBranch: branch } : w,
    );
    try {
      await registerBoxWithRelay({
        boxId: box.id,
        token: box.relayToken,
        name: box.name,
        containerName: box.container,
        createdAt: box.createdAt,
        projectIndex: box.projectIndex,
        worktrees,
        autoApproveHostActions: box.autoApproveHostActions,
        autoApproveSafeHostActions: box.autoApproveSafeHostActions,
      });
    } catch {
      // best-effort — relay may be down; the persisted state re-registers on
      // the next `relay` rehydrate.
    }
  }
}

/** Stream a shared-helper exec result to the terminal, then exit with its code. */
async function streamExit(r: ExecResult): Promise<never> {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  return exitWith(r.exitCode);
}

/**
 * BoxGitDeps for the shared helpers: forward each credentialed RPC's
 * `(method, params)` to the host-initiated-token minter. The helpers only ever
 * build `{ path, remote?, args? }`, so the cast to PredictedGitParams is safe
 * (path is always set) and the params hash round-trips with what ctl sends.
 */
function gitDeps(box: BoxRecord): BoxGitDeps {
  return {
    hostInitiatedArgs: (method, params) => hostInitiatedArgs(box.id, method, params as PredictedGitParams),
  };
}

/**
 * Shape of the RPC params `agentbox-ctl` will send to the relay. The host
 * CLI must compute this *exactly* so the hash binding round-trips. Kept in
 * lockstep with `buildParams` in `packages/ctl/src/commands/git.ts` and the
 * action body in `packages/ctl/src/commands/pr-subcommands.ts`. The `cwd` is
 * always `/workspace` because our `provider.exec` call below sets it
 * explicitly; ctl mirrors `process.cwd()` into `params.path`.
 */
interface PredictedGitParams {
  path: string;
  remote?: string;
  args?: string[];
}
interface PredictedGhPrParams {
  path: string;
  args?: string[];
}

/**
 * Mint a host-initiated token bound to the exact params hash + return the
 * `--host-initiated-token <tok>` argv fragment to splice into an
 * `agentbox-ctl` invocation. Empty fragment on mint failure — the call
 * still works, the relay just prompts instead of auto-approving.
 *
 * Why CLI arg (not env): envs propagate to children, so a `git push`
 * pre-push hook would inherit the token. Why bound to paramsHash: /proc/<pid>
 * /cmdline is world-readable, so a malicious in-box process could harvest
 * the token mid-flight and replay with mutated args (e.g. `--force`). The
 * paramsHash binding means a harvested token is only usable for the exact
 * params the host CLI committed to.
 */
async function hostInitiatedArgs(
  boxId: string,
  method: string,
  predictedParams: PredictedGitParams | PredictedGhPrParams,
): Promise<string[]> {
  const paramsHash = hashRpcParams(predictedParams);
  const token = await mintHostInitiatedToken(boxId, method, paramsHash, TOKEN_TTL_MS);
  return token ? ['--host-initiated-token', token] : [];
}

/** Build the `{ path, remote?, args? }` ctl will send for git RPCs. */
function buildPredictedGitParams(remote: string | undefined, extraArgs: string[]): PredictedGitParams {
  const out: PredictedGitParams = { path: WORKSPACE };
  if (remote) out.remote = remote;
  if (extraArgs.length > 0) out.args = extraArgs;
  return out;
}

/** Build the `{ path, args? }` ctl will send for gh.pr.<op> RPCs. */
function buildPredictedGhPrParams(ghArgs: string[]): PredictedGhPrParams {
  const out: PredictedGhPrParams = { path: WORKSPACE };
  if (ghArgs.length > 0) out.args = ghArgs;
  return out;
}

async function exitWith(code: number): Promise<never> {
  process.exit(code);
}

// ---- subcommands -----------------------------------------------------------

const pushCommand = new Command('push')
  .description("Push the box's branch via the host relay (host creds, no prompt)")
  .argument('<box>', 'box ref: project index, id, id prefix, name, or container')
  .argument('[args...]', 'extra flags forwarded to `agentbox-ctl git push` (e.g. --force-with-lease, --tags)')
  .option('--remote <name>', 'remote name (default: origin)')
  .option('--host-only', "land the branch in the host's local repo only; do NOT push to the remote (nothing is published online)")
  .option('--as <branch>', "with --host-only: destination branch name in the host repo (default: the box's branch name)")
  .option('--force', 'with --host-only: allow a non-fast-forward overwrite of the destination branch')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(
    async (
      boxRef: string,
      args: string[],
      opts: { remote?: string; hostOnly?: boolean; as?: string; force?: boolean },
    ) => {
      try {
        if (opts.hostOnly && opts.remote) {
          process.stderr.write('agentbox git push: --host-only does not use a remote; drop --remote\n');
          await exitWith(64);
        }
        const box = await resolveBoxOrExit(boxRef);
        const provider = await providerForBox(box);
        if (opts.hostOnly) {
          // Host-only landing publishes nothing, so the relay skips its
          // push-confirm gate entirely — no host-initiated token needed.
          await streamExit(await boxGitPushHost(provider, box, { as: opts.as, force: opts.force, args }));
          return;
        }
        // --force is a real remote-push flag; the helper appends it to the args
        // tail and folds it into the params hash so the minted token matches.
        await streamExit(
          await boxGitPush(provider, box, { remote: opts.remote, force: opts.force, args }, gitDeps(box)),
        );
      } catch (err) {
        handleLifecycleError(err);
      }
    },
  );

const fetchCommand = new Command('fetch')
  .description('Fetch via the host relay (refs land in the shared .git)')
  .argument('<box>', 'box ref')
  .argument('[args...]', 'extra flags forwarded to `agentbox-ctl git fetch` (e.g. --prune)')
  .option('--remote <name>', 'remote name (default: origin)')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (boxRef: string, args: string[], opts: { remote?: string }) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      // Fetch is read-only host-side and the relay doesn't prompt for it; we
      // still mint a token so future relay hardening that adds a prompt
      // doesn't break this command silently.
      const predicted = buildPredictedGitParams(opts.remote, args);
      const tokenArgs = await hostInitiatedArgs(box.id, 'git.fetch', predicted);
      const argv = ['agentbox-ctl', 'git', 'fetch', ...tokenArgs];
      if (opts.remote) argv.push('--remote', opts.remote);
      argv.push(...args);
      await exitWith(await runAndStream(box, argv));
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const pullCommand = new Command('pull')
  .description(
    "Fetch via the relay then merge in /workspace. With <branch>: first `git checkout <branch>` so the box switches base branch and pulls latest — useful for reusing a box on a new task.",
  )
  .argument('<box>', 'box ref')
  .argument('[branch]', 'optional branch to switch to before pulling (e.g. main)')
  .argument('[args...]', 'extra flags forwarded to `agentbox-ctl git pull`')
  .option('--remote <name>', 'remote name (default: origin)')
  .option('--ff-only', 'pass --ff-only to the in-box merge')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(
    async (
      boxRef: string,
      branch: string | undefined,
      args: string[],
      opts: { remote?: string; ffOnly?: boolean },
    ) => {
      try {
        const box = await resolveBoxOrExit(boxRef);
        const provider = await providerForBox(box);
        if (branch) {
          const switched = await boxGitCheckout(provider, box, branch);
          if (switched.stdout) process.stdout.write(switched.stdout);
          if (switched.stderr) process.stderr.write(switched.stderr);
          if (switched.exitCode !== 0) await exitWith(switched.exitCode);
          // Host switched the box onto <branch> — sanction it so the following
          // pull/push don't prompt to touch the branch the host just picked.
          await sanctionBoxBranch(box, branch);
        }
        await streamExit(
          await boxGitPull(provider, box, { remote: opts.remote, ffOnly: opts.ffOnly, args }, gitDeps(box)),
        );
      } catch (err) {
        handleLifecycleError(err);
      }
    },
  );

const checkoutCommand = new Command('checkout')
  .description('Change the box\'s working branch (runs `git checkout <branch>` in /workspace)')
  .argument('<box>', 'box ref')
  .argument('<branch>', 'branch to check out inside the box')
  .argument('[args...]', 'extra flags forwarded to `git checkout`')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (boxRef: string, branch: string, args: string[]) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const r = await boxGitCheckout(provider, box, branch, args);
      // Host-sanctioned branch switch: record it so pushing this branch skips
      // the confirm prompt (an in-box agent's own checkout does not).
      if (r.exitCode === 0) await sanctionBoxBranch(box, branch);
      await streamExit(r);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const branchCommand = new Command('branch')
  .description('Create a new agentbox/* branch from HEAD (or a given base) and switch the box onto it')
  .argument('<box>', 'box ref')
  .argument('<name>', "new branch name (an 'agentbox/' prefix is added when missing)")
  .option('--from <ref>', 'base ref to fork from (default: the box\'s current HEAD)')
  .action(async (boxRef: string, name: string, opts: { from?: string }) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      const provider = await providerForBox(box);
      const r = await boxGitNewBranch(provider, box, name, opts.from);
      // The new branch is always an `agentbox/*` scratch branch (already
      // gate-exempt), but record it as sanctioned for consistency + in case
      // the scratch-prefix policy ever changes.
      if (r.exitCode === 0) await sanctionBoxBranch(box, scratchBranchName(name));
      await streamExit(r);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const statusCommand = new Command('status')
  .description('Run `git status` in the box\'s /workspace (read-only, no relay)')
  .argument('<box>', 'box ref')
  .argument('[args...]', 'extra flags forwarded to `git status`')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (boxRef: string, args: string[]) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      await exitWith(await runAndStream(box, ['git', 'status', ...args]));
    } catch (err) {
      handleLifecycleError(err);
    }
  });

// ---- pr group --------------------------------------------------------------
//
// Mirrors the in-box `agentbox-ctl gh pr <op>` surface 1:1. `create` is the
// default subcommand so `agentbox git pr <box>` is sugar for
// `agentbox git pr create <box>` — matches how users naturally describe it.

const PR_OP_DESCRIPTIONS: Record<GhPrOp, string> = {
  create: "Open a PR for the box's branch (host `gh pr create`, no prompt).",
  view: 'Show a PR (read-only).',
  list: 'List PRs (read-only).',
  diff: 'Show a PR diff (read-only).',
  checks: "Show a PR's CI check status (read-only).",
  comment: 'Comment on a PR.',
  review: 'Review a PR.',
  merge:
    'Merge a PR (host `gh pr merge`). AGENTBOX_PROMPT=off bypass still requires AGENTBOX_GH_FORCE=1.',
  checkout:
    "Check out a PR's branch on the host main repo (opt-in via AGENTBOX_GH_PR_CHECKOUT=allow; switches the host repo branch).",
  close: 'Close a PR.',
  reopen: 'Reopen a PR.',
};

/**
 * Default to the box's root branch as `--head` on `gh pr create` so the PR
 * is for the box's branch, not whatever the host happens to have checked
 * out (gh's default infers head from the cwd's HEAD, which is `feat/test`
 * or similar when the user is mid-task). Only injected when the user hasn't
 * already passed `--head`, and only for `create`. The relay's
 * `worktree.hostMainRepo` is the cwd `gh` runs in, so passing `--head` is
 * sufficient — base stays whatever the user picked / repo default.
 */
function injectPrCreateHead(op: GhPrOp, box: { gitWorktrees?: { kind: string; branch: string }[] }, args: string[]): string[] {
  const rootWt = (box.gitWorktrees ?? []).find((w) => w.kind === 'root');
  return injectHead(op, rootWt?.branch, args);
}

function buildPrSubcommand(op: GhPrOp): Command {
  return new Command(op)
    .description(PR_OP_DESCRIPTIONS[op])
    .argument('<box>', 'box ref')
    .argument(
      '[args...]',
      'extra flags forwarded to `gh pr <op>` (e.g. --title, --body, --label, --draft, --json)',
    )
    .allowExcessArguments(true)
    .allowUnknownOption(true)
    .action(async (boxRef: string, args: string[]) => {
      try {
        const box = await resolveBoxOrExit(boxRef);
        const ghArgs = injectPrCreateHead(op, box, args);
        // Hash the args *after* injection so the bound paramsHash matches
        // what ctl will end up sending.
        const predicted = buildPredictedGhPrParams(ghArgs);
        const tokenArgs = await hostInitiatedArgs(box.id, `gh.pr.${op}`, predicted);
        const argv = ['agentbox-ctl', 'gh', 'pr', op, ...tokenArgs, ...ghArgs];
        await exitWith(await runAndStream(box, argv));
      } catch (err) {
        handleLifecycleError(err);
      }
    });
}

const prCommand = new Command('pr').description(
  "PR operations against a box's branch via the host `gh` CLI",
);
for (const op of GH_PR_OPS) {
  const sub = buildPrSubcommand(op);
  prCommand.addCommand(sub, op === 'create' ? { isDefault: true } : undefined);
}

// ---- root ------------------------------------------------------------------

export const gitCommand = new Command('git')
  .description('Run git / gh pr operations against a box from the host')
  .addCommand(pushCommand)
  .addCommand(fetchCommand)
  .addCommand(pullCommand)
  .addCommand(checkoutCommand)
  .addCommand(branchCommand)
  .addCommand(statusCommand)
  .addCommand(prCommand);
