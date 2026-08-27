import type { BoxRecord, ExecResult } from '@agentbox/core';
import { hashRpcParams, injectPrCreateHead as injectHead } from '@agentbox/relay';
import { mintHostInitiatedToken } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveBoxOrExit } from '../box-ref.js';
import type { HubApiOpResult } from '../control-plane/hub-api-client.js';
import { withHubClient } from '../control-plane/with-hub.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

/**
 * `agentbox git <subcommand> <box>` — host-side proxy for git/PR operations
 * against a specific box.
 *
 * The branch-mutating ops (`push`, `pull`, `checkout`, `branch`,
 * `push --host-only`) go through the hub's public `/api/v1`
 * (`POST /boxes/:id/git/:op` via {@link withHubClient}), so they work
 * identically against a local hub and a remote control box — the hub owns the
 * host-initiated-token mint + branch sanctioning that used to live here. The
 * box command's own exit code is carried faithfully through the error envelope
 * (`error.details.exitCode`), so e.g. `push --host-only` against a box whose
 * host has no working copy still surfaces the server's exit 64.
 *
 * `fetch`, `status`, and the `pr` group stay INLINE: no `/api/v1` route exists
 * for them yet, so they resolve the box + provider directly and run the
 * matching `agentbox-ctl git` / `agentbox-ctl gh pr` (or raw `git`) in the
 * box's /workspace. Their credentialed RPCs (fetch, gh pr) carry a one-time
 * scoped token minted by the host via `mintHostInitiatedToken`; the relay
 * validates it and skips its confirm prompt on match. A simple "host-initiated"
 * boolean would be forgeable by the box agent (the agent sees the argv); the
 * one-time token isn't (the mint endpoint is loopback-only). If the relay can't
 * mint (older relay / not running), the call still proceeds — it just goes
 * through the normal prompt path on the wrapper side.
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

/** Write a hub git-op result's captured stdout/stderr to the terminal. */
function streamOp(r: HubApiOpResult): void {
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
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
function buildPredictedGitParams(
  remote: string | undefined,
  extraArgs: string[],
): PredictedGitParams {
  const out: PredictedGitParams = { path: WORKSPACE };
  if (remote) out.remote = remote;
  if (extraArgs.length > 0) out.args = extraArgs;
  return out;
}

/** Build the `{ path, args? }` ctl will send for the gh.exec RPC. */
function buildPredictedGhPrParams(op: string, ghArgs: string[]): PredictedGhPrParams {
  // Must mirror exactly what ctl posts, since the minted token is bound to a
  // hash of these params.
  return { path: WORKSPACE, args: ['pr', op, ...ghArgs] };
}

async function exitWith(code: number): Promise<never> {
  process.exit(code);
}

// ---- subcommands -----------------------------------------------------------

const pushCommand = new Command('push')
  .description("Push the box's branch via the host relay (host creds, no prompt)")
  .argument('<box>', 'box ref: project index, id, id prefix, name, or container')
  .argument(
    '[args...]',
    'extra flags forwarded to `agentbox-ctl git push` (e.g. --force-with-lease, --tags)',
  )
  .option('--remote <name>', 'remote name (default: origin)')
  .option(
    '--host-only',
    "land the branch in the host's local repo only; do NOT push to the remote (nothing is published online)",
  )
  .option(
    '--as <branch>',
    "with --host-only: destination branch name in the host repo (default: the box's branch name)",
  )
  .option(
    '--force',
    'with --host-only: allow a non-fast-forward overwrite of the destination branch',
  )
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
          process.stderr.write(
            'agentbox git push: --host-only does not use a remote; drop --remote\n',
          );
          await exitWith(64);
        }
        const box = await resolveBoxOrExit(boxRef);
        await withHubClient({}, async (client) => {
          // No `mode` pre-check for --host-only: a `hub expose`d machine reports
          // mode 'remote' yet IS the host with the checkout, so host-only
          // succeeds there. The real condition — does this box's host have a
          // working copy — is checked server-side, which returns exit 64 (carried
          // faithfully via the error envelope) when it genuinely doesn't.
          const r = opts.hostOnly
            ? await client.git(box.id, 'push-host', { as: opts.as, force: opts.force, args })
            : await client.git(box.id, 'push', { remote: opts.remote, force: opts.force, args });
          streamOp(r);
        });
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
    'Fetch via the relay then merge in /workspace. With <branch>: first `git checkout <branch>` so the box switches base branch and pulls latest — useful for reusing a box on a new task.',
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
        await withHubClient({}, async (client) => {
          if (branch) {
            // The hub sanctions <branch> after a 0-exit checkout, so the
            // following pull/push don't prompt to touch the branch the host
            // just picked. A non-zero checkout throws → the pull is skipped.
            streamOp(await client.git(box.id, 'checkout', { branch }));
          }
          streamOp(
            await client.git(box.id, 'pull', { remote: opts.remote, ffOnly: opts.ffOnly, args }),
          );
        });
      } catch (err) {
        handleLifecycleError(err);
      }
    },
  );

const checkoutCommand = new Command('checkout')
  .description("Change the box's working branch (runs `git checkout <branch>` in /workspace)")
  .argument('<box>', 'box ref')
  .argument('<branch>', 'branch to check out inside the box')
  .argument('[args...]', 'extra flags forwarded to `git checkout`')
  .allowExcessArguments(true)
  .allowUnknownOption(true)
  .action(async (boxRef: string, branch: string, args: string[]) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      // The hub sanctions <branch> after a 0-exit checkout, so pushing this
      // branch skips the confirm prompt (an in-box agent's own checkout does not).
      await withHubClient({}, async (client) => {
        streamOp(await client.git(box.id, 'checkout', { branch, args }));
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const branchCommand = new Command('branch')
  .description(
    'Create a new agentbox/* branch from HEAD (or a given base) and switch the box onto it',
  )
  .argument('<box>', 'box ref')
  .argument('<name>', "new branch name (an 'agentbox/' prefix is added when missing)")
  .option('--from <ref>', "base ref to fork from (default: the box's current HEAD)")
  .action(async (boxRef: string, name: string, opts: { from?: string }) => {
    try {
      const box = await resolveBoxOrExit(boxRef);
      // The hub records the new `agentbox/*` scratch branch as sanctioned (it's
      // already gate-exempt, but kept for consistency + a future prefix policy).
      await withHubClient({}, async (client) => {
        streamOp(await client.git(box.id, 'branch', { name, from: opts.from }));
      });
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const statusCommand = new Command('status')
  .description("Run `git status` in the box's /workspace (read-only, no relay)")
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

// The host CLI keeps a fixed, named set of `agentbox git pr <op>` commands
// for discoverability. The relay no longer enumerates gh ops (it forwards
// whatever the box sends and gates by policy), so the union lives here now.
const PR_OP_DESCRIPTIONS = {
  create: "Open a PR for the box's branch (host `gh pr create`).",
  view: 'Show a PR (read-only).',
  list: 'List PRs (read-only).',
  diff: 'Show a PR diff (read-only).',
  checks: "Show a PR's CI check status (read-only).",
  comment: 'Comment on a PR.',
  review: 'Review a PR.',
  merge: 'Merge a PR (host `gh pr merge`).',
  checkout:
    "Check out a PR's branch on the host main repo (opt-in via AGENTBOX_GH_PR_CHECKOUT=allow; switches the HOST repo branch).",
  close: 'Close a PR.',
  reopen: 'Reopen a PR.',
} as const;

type GhPrOp = keyof typeof PR_OP_DESCRIPTIONS;
const GH_PR_OPS = Object.keys(PR_OP_DESCRIPTIONS) as GhPrOp[];

/**
 * Default to the box's root branch as `--head` on `gh pr create` so the PR
 * is for the box's branch, not whatever the host happens to have checked
 * out (gh's default infers head from the cwd's HEAD, which is `feat/test`
 * or similar when the user is mid-task). Only injected when the user hasn't
 * already passed `--head`, and only for `create`. The relay's
 * `worktree.hostMainRepo` is the cwd `gh` runs in, so passing `--head` is
 * sufficient — base stays whatever the user picked / repo default.
 */
function injectPrCreateHead(
  op: GhPrOp,
  box: { gitWorktrees?: { kind: string; branch: string }[] },
  args: string[],
): string[] {
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
        const predicted = buildPredictedGhPrParams(op, ghArgs);
        const tokenArgs = await hostInitiatedArgs(box.id, 'gh.exec', predicted);
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
