import { Command, Option } from 'commander';
import { resolveRemote, type GitRpcParams } from '@agentbox/core';
import { spawn } from 'node:child_process';
import { postRpcAndExit, postRpcAwait } from '../relay-rpc.js';
import { buildPrCommand } from './pr-subcommands.js';

/**
 * Hidden CLI flag carrying a one-time scoped token minted by the host CLI
 * via the relay's loopback-only `/admin/host-initiated/mint`. The relay
 * validates the token + (boxId, method) scope on the receiving RPC and
 * skips its confirm prompt on match. We use a CLI arg (not an env var)
 * because env vars are inherited by child processes — a `git push`
 * pre-push hook (or any other in-box command agentbox-ctl spawns) would
 * inherit the token and could replay it. The CLI arg lives only on the
 * agentbox-ctl process itself.
 */
function hostInitiatedOption(): Option {
  return new Option(
    '--host-initiated-token <token>',
    'internal: one-time token from the host CLI; skips relay confirm prompt when valid',
  ).hideHelp();
}

interface CommonOptions {
  remote?: string;
  cwd?: string;
  /** Set by the host CLI; carries a one-time token the relay validates. */
  hostInitiatedToken?: string;
}

export interface PushOptions extends CommonOptions {
  /** Land the branch in the host's local repo only; never push to the remote. */
  hostOnly?: boolean;
  /** With --host-only: destination branch name on the host (default: box branch). */
  as?: string;
  /** With --host-only: allow a non-fast-forward overwrite of the destination. */
  force?: boolean;
}

interface GitCloneRpcParams {
  path: string;
  url: string;
  targetPath?: string;
  args?: string[];
}

export function buildParams(opts: PushOptions, extra: string[]): GitRpcParams {
  const args = [...extra];
  const params: GitRpcParams = { path: opts.cwd ?? process.cwd() };
  if (opts.remote) params.remote = opts.remote;
  if (opts.hostOnly) {
    params.hostOnly = true;
    if (opts.as) params.as = opts.as;
    if (opts.force) params.force = true;
  } else if (opts.force) {
    // Not host-only: --force is a real remote-push flag. `params.force` is only
    // honored on the host-only land path, so forward it as a git arg here so
    // the relay appends it to `git push <remote> <branch>`.
    args.push('--force');
  }
  if (args.length > 0) params.args = args;
  if (opts.hostInitiatedToken) params.hostInitiated = opts.hostInitiatedToken;
  return params;
}

/**
 * Run a local `git` command inside the box, streaming output to the parent's
 * stdio. Used by `pull` for the in-container merge step (no creds needed —
 * the fetch already happened host-side via the relay).
 */
function runLocalGit(args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', (err) => {
      process.stderr.write(`agentbox-ctl git: ${String(err.message ?? err)}\n`);
      resolve(126);
    });
  });
}

/**
 * `pull` is a relay fetch + a local merge, so its passthrough flags have to be
 * split across the two: `git fetch` rejects `--ff-only`, `git merge` rejects
 * `--prune`. Everything the git shim allows for `pull` is classified here.
 *
 * These arrive as passthrough args rather than commander options because the
 * shim forwards them after a `--` separator (`agentbox-ctl git pull -- --ff-only`),
 * which makes commander treat them as positionals and leave `opts.ffOnly` unset.
 */
export function partitionPullArgs(args: string[]): { fetchArgs: string[]; mergeArgs: string[] } {
  const fetchArgs: string[] = [];
  const mergeArgs: string[] = [];
  for (const arg of args) {
    switch (arg) {
      case '--ff-only':
        mergeArgs.push(arg);
        break;
      case '--quiet':
      case '-q':
        fetchArgs.push(arg);
        mergeArgs.push(arg);
        break;
      default:
        fetchArgs.push(arg);
    }
  }
  return { fetchArgs, mergeArgs };
}

/** Run a local `git` command and capture its trimmed stdout ('' on failure). */
function captureGit(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', () => resolve(out.trim()));
    child.on('error', () => resolve(''));
  });
}

/**
 * Control-plane push: instead of the relay pushing host-side, the box leases a
 * repo-scoped GitHub-App token from the control plane and pushes directly.
 * Used when AGENTBOX_GIT_LEASE=1. The host writes that flag into
 * /etc/agentbox/box.env at create/resume when a control-plane URL is configured
 * (the daemon's own env isn't inherited by the login shell that runs `git
 * push`, so the flag must live in box.env). The token lives in the remote URL
 * config for the push only and is scrubbed (origin restored) in `finally` —
 * never in the push argv.
 */
async function leaseAndPush(opts: CommonOptions, extra: string[]): Promise<number> {
  const prefix = 'agentbox-ctl git';
  const cwd = opts.cwd ?? process.cwd();
  const lease = await postRpcAwait('git.lease-token', buildParams(opts, []), { errorPrefix: prefix });
  if (lease.exitCode !== 0) {
    if (lease.stderr) process.stderr.write(lease.stderr);
    return lease.exitCode;
  }
  let remoteUrl = '';
  try {
    const parsed = JSON.parse(lease.stdout) as { remoteUrl?: unknown };
    if (typeof parsed.remoteUrl === 'string') remoteUrl = parsed.remoteUrl;
  } catch {
    /* handled below */
  }
  if (!remoteUrl) {
    process.stderr.write(`${prefix}: lease response missing remoteUrl\n`);
    return 1;
  }
  const remote = resolveRemote(opts.remote);
  const branch = await captureGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (!branch) {
    process.stderr.write(`${prefix}: could not resolve current branch\n`);
    return 1;
  }
  const originalUrl = await captureGit(['remote', 'get-url', remote], cwd);
  await runLocalGit(['remote', 'set-url', remote, remoteUrl], cwd);
  try {
    return await runLocalGit(['push', remote, branch, ...extra], cwd);
  } finally {
    if (originalUrl) await runLocalGit(['remote', 'set-url', remote, originalUrl], cwd);
  }
}

/**
 * True when the box has a git committer identity configured (`user.email`).
 * Docker boxes bind-mount the host `~/.gitconfig`, so they do; cloud boxes
 * (e.g. Vercel's `vscode` user on fresh AL2023) often don't, which makes a
 * non-fast-forward `git pull` merge fail with "Committer identity unknown".
 */
function hasGitIdentity(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['config', 'user.email'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let out = '';
    child.stdout.on('data', (c: Buffer) => (out += c.toString('utf8')));
    child.on('close', (code) => resolve(code === 0 && out.trim().length > 0));
    child.on('error', () => resolve(false));
  });
}

export const gitCommand = new Command('git')
  .description('Git operations that need host credentials (routed through the agentbox relay)')
  .addCommand(
    new Command('push')
      .description("Run `git push` on the host main repo against this box's branch (user is prompted on the host wrapper to confirm)")
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .option('--host-only', "land the branch in the host's local repo only; do NOT push to the remote (nothing is published online)")
      .option('--as <branch>', "with --host-only: destination branch name in the host repo (default: this box's branch name)")
      .option('--force', 'with --host-only: allow a non-fast-forward overwrite of the destination branch')
      .addOption(hostInitiatedOption())
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument(
        '[args...]',
        "extra flags appended to the host-built `git push <remote> <branch>` (e.g. `--force-with-lease`, `--tags`). Do NOT re-pass the remote or branch — they are taken from --remote and the registered worktree; appending them as positionals makes git treat them as refspecs and fail with `refs/remotes/origin/HEAD cannot be resolved to branch`. Use --remote to change the remote.",
      )
      .action(async (args: string[], opts: PushOptions) => {
        if (opts.hostOnly && opts.remote) {
          process.stderr.write('agentbox-ctl git push: --host-only does not use a remote; drop --remote\n');
          process.exit(64);
        }
        // Control-plane boxes lease a token and push directly; everyone else
        // routes the push through the relay (host creds / cloud poller).
        const code =
          process.env.AGENTBOX_GIT_LEASE === '1'
            ? await leaseAndPush(opts, args)
            : await postRpcAndExit('git.push', buildParams(opts, args), {
                errorPrefix: 'agentbox-ctl git',
              });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('fetch')
      .description('Run `git fetch` on the host main repo (refs land in the shared .git)')
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .addOption(hostInitiatedOption())
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument(
        '[args...]',
        'extra flags appended to the host-built `git fetch <remote> <branch>` (e.g. `--prune`, `--tags`). Do NOT re-pass the remote or branch; they come from --remote and the registered worktree (same gotcha as `push`).',
      )
      .action(async (args: string[], opts: CommonOptions) => {
        const code = await postRpcAndExit('git.fetch', buildParams(opts, args), {
          errorPrefix: 'agentbox-ctl git',
        });
        process.exit(code);
      }),
  )
  .addCommand(
    new Command('pull')
      .description(
        'Fetch via the relay (host creds), then merge into the in-container working tree locally',
      )
      .option('--remote <name>', 'remote name (default: origin)')
      .option('--cwd <path>', 'container path identifying which registered worktree to use')
      .option('--ff-only', 'pass --ff-only to the local merge')
      .addOption(hostInitiatedOption())
      .allowExcessArguments(true)
      .allowUnknownOption(true)
      .argument(
        '[args...]',
        'extra flags, split between the host-built `git fetch <remote> <branch>` (e.g. `--prune`) and the local merge (`--ff-only`; `--quiet` goes to both). Do NOT re-pass the remote or branch; they come from --remote and the registered worktree (same gotcha as `push`).',
      )
      .action(
        async (
          args: string[],
          opts: CommonOptions & { ffOnly?: boolean },
        ) => {
          const { fetchArgs, mergeArgs: passthroughMergeArgs } = partitionPullArgs(args);
          const fetchCode = await postRpcAndExit('git.fetch', buildParams(opts, fetchArgs), {
            errorPrefix: 'agentbox-ctl git',
          });
          if (fetchCode !== 0) process.exit(fetchCode);
          // Merge happens in the container, where the working tree lives. No
          // creds needed; refs are already in the shared .git from the fetch.
          const remote = resolveRemote(opts.remote);
          // Resolve branch via the current HEAD's upstream, falling back to
          // `<remote>/HEAD` so a freshly cloned worktree still pulls.
          const cwd = opts.cwd ?? process.cwd();
          // A non-fast-forward merge writes a merge commit, which needs a
          // committer identity. Fall back to a generic agentbox identity only
          // when the box has none of its own — docker boxes inherit the user's
          // bind-mounted ~/.gitconfig and should keep authoring as the user.
          // Mirrors the resync merge in sandbox-docker/src/in-box-git.ts.
          const mergeArgs: string[] = [];
          if (!(await hasGitIdentity(cwd))) {
            mergeArgs.push(
              '-c',
              'user.name=agentbox',
              '-c',
              'user.email=agentbox@users.noreply.github.com',
            );
          }
          mergeArgs.push('merge');
          // `--ff-only` reaches us either as a commander option (direct
          // `agentbox-ctl` call) or as a passthrough arg (via the git shim's `--`).
          if (opts.ffOnly && !passthroughMergeArgs.includes('--ff-only')) {
            mergeArgs.push('--ff-only');
          }
          mergeArgs.push(...passthroughMergeArgs);
          mergeArgs.push(`${remote}/HEAD`);
          const mergeCode = await runLocalGit(mergeArgs, cwd);
          process.exit(mergeCode);
        },
      ),
  )
  .addCommand(
    new Command('clone')
      .description(
        "Clone a github repo into the box. Host runs `git clone` with its creds into a tmpdir, bundles, and ships the bundle back; the box materialises the working copy and resets origin to the original URL.",
      )
      .option('--cwd <path>', 'container path identifying which registered worktree to use (default: cwd)')
      .option('--branch <name>', 'pass --branch <name> to host git clone')
      .option('--depth <n>', 'pass --depth <n> to host git clone')
      .argument('<url>', 'github URL or owner/name shorthand')
      .argument('[dir]', 'target directory inside the box (default: derived from url)')
      .action(
        async (
          url: string,
          dir: string | undefined,
          opts: { cwd?: string; branch?: string; depth?: string },
        ) => {
          const params: GitCloneRpcParams = {
            path: opts.cwd ?? process.cwd(),
            url,
          };
          if (dir) params.targetPath = dir;
          const extra: string[] = [];
          if (opts.branch) extra.push('--branch', opts.branch);
          if (opts.depth) extra.push('--depth', opts.depth);
          if (extra.length > 0) params.args = extra;
          const code = await postRpcAndExit('git.clone', params, {
            errorPrefix: 'agentbox-ctl git clone',
          });
          process.exit(code);
        },
      ),
  )
  .addCommand(buildPrCommand('agentbox-ctl git pr'));
