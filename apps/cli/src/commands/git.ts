/**
 * `agentbox git` — host-side git operations against an agentbox box.
 *
 * Today this surfaces one subcommand: `agentbox git box-fetch <box> [refspec...]`,
 * which fetches refs from a *Hetzner* box's workspace into the host repo over
 * SSH using the per-box key. No persistent remote is registered; the box is
 * just hit as `ssh://vscode@<vps>/workspace` for this one invocation. Refs
 * land under `refs/remotes/agentbox-<box-id>/*` by default so they're scoped
 * and easy to find with `git for-each-ref refs/remotes/agentbox-*`.
 *
 * Other providers fail with a clear message (docker shares `.git/` already
 * via bind-mount; Daytona has no SSH passthrough — use the bundle path via
 * `agentbox-ctl git push` instead).
 */

import { Command } from 'commander';
import { execa } from 'execa';
import { log } from '@clack/prompts';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

const VPS_USER = 'vscode';

/**
 * Single-quote shell-quote a path so it survives `GIT_SSH_COMMAND`'s
 * shell parsing. Paths normally come from `~/.agentbox/boxes/…` so the only
 * realistic special characters are spaces (when $HOME contains a space).
 * `'` is escaped via the standard `'\''` trick.
 */
function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export const gitCommand = new Command('git')
  .description('Git operations between the host and a box (Hetzner only).')
  .addCommand(
    new Command('box-fetch')
      .description(
        "Fetch refs from a Hetzner box's /workspace into the host repo over SSH " +
          '(no persistent remote registered). Default refspec lands branches under ' +
          'refs/remotes/agentbox-<box-id>/*. Use `git for-each-ref refs/remotes/agentbox-*` to list.',
      )
      .argument('[box]', 'box name / id / index (auto-picked when unambiguous in the cwd project)')
      .argument(
        '[refspec...]',
        "git fetch refspecs (default: '+refs/heads/*:refs/remotes/agentbox-<box-id>/*')",
      )
      .action(async (box: string | undefined, refspecs: string[]) => {
        try {
          const record = await resolveBoxOrExit(box);
          if ((record.provider ?? 'docker') !== 'hetzner') {
            log.error(
              `agentbox git box-fetch is hetzner-only (this box is ${record.provider ?? 'docker'}). ` +
                `Docker boxes share .git/ via bind-mount; Daytona has no SSH passthrough — ` +
                `use \`agentbox-ctl git push\` from inside the box instead.`,
            );
            process.exit(2);
          }
          const sandboxId = record.cloud?.sandboxId;
          if (!sandboxId) {
            log.error(`box ${record.id} has no cloud.sandboxId — record is malformed`);
            process.exit(2);
          }

          // Resolve the live VPS IP + per-box ssh identity. Imported lazily so
          // the cli command doesn't pull the hetzner module on docker-only
          // invocations.
          const { resolveHetznerBoxSshTarget } = await import('@agentbox/sandbox-hetzner');
          const target = await resolveHetznerBoxSshTarget(sandboxId);

          // GIT_SSH_COMMAND is parsed by a shell, so paths with spaces (e.g.
          // a `$HOME` like `/Users/Foo Bar/…`) need quoting. `UserKnownHostsFile`
          // gets quoted inside the `-o` value because shellQuote on the whole
          // `key=value` would put the quotes around `key=value` and ssh would
          // see the literal quotes.
          const gitSshCommand = [
            'ssh',
            '-i', shQuote(target.identity),
            '-o', 'StrictHostKeyChecking=accept-new',
            '-o', `UserKnownHostsFile=${shQuote(target.knownHosts)}`,
            '-o', 'GlobalKnownHostsFile=/dev/null',
            '-o', 'BatchMode=yes',
            '-o', 'LogLevel=ERROR',
          ].join(' ');

          // ssh://vscode@<vps>/workspace — git-upload-pack runs against the
          // worktree's .git/, returning the box's per-box branch refs.
          const remoteUrl = `ssh://${VPS_USER}@${target.host}/workspace`;
          const effectiveRefspecs =
            refspecs.length > 0
              ? refspecs
              : [`+refs/heads/*:refs/remotes/agentbox-${record.id}/*`];

          const argv = ['-C', record.workspacePath, 'fetch', remoteUrl, ...effectiveRefspecs];
          const res = await execa('git', argv, {
            reject: false,
            env: { ...process.env, GIT_SSH_COMMAND: gitSshCommand },
            stdio: 'inherit',
          });
          process.exit(res.exitCode ?? 1);
        } catch (err) {
          handleLifecycleError(err);
        }
      }),
  );
