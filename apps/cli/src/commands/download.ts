import { confirm, log } from '../lib/prompt.js';
import { Command } from 'commander';
import {
  DEFAULT_ENV_PATTERNS,
  inspectBox,
  pullToHost,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';
import { downloadClaudeCommand } from './download-claude.js';
import { downloadCodexCommand } from './download-codex.js';
import { downloadOpencodeCommand } from './download-opencode.js';
import { downloadConfigCommand } from './download-config.js';
import { downloadEnvCommand } from './download-env.js';

interface DownloadOpts {
  yes?: boolean;
  dryRun?: boolean;
  respectGitignore: boolean; // commander gives `--no-respect-gitignore` => false
  includeNodeModules?: boolean;
  refresh: boolean; // commander gives `--no-refresh` => false
  withEnv?: boolean;
  pattern: string[];
}

export const downloadCommand = new Command('download')
  // Parent and the `env` subcommand share option names (--dry-run, -y,
  // --pattern). Positional options make post-subcommand options bind to the
  // subcommand instead of being swallowed by this parent command.
  .enablePositionalOptions()
  .description("Download a box's /workspace back into your host workspace dir (gitignore-aware)")
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "print the change list and exit; don't write")
  .option(
    '--no-respect-gitignore',
    'disable git ls-files mode; use --exclude=node_modules,.git instead',
  )
  .option(
    '--include-node-modules',
    'do not exclude node_modules in fallback mode (no effect in gitignore mode)',
  )
  .option('--no-refresh', "skip the box->scratch-dir rsync step (use whatever's already there)")
  .option(
    '--with-env',
    'also download env/config files (.env*, .envrc, secrets.toml, agentbox.yaml, ...) ignoring gitignore',
  )
  .option(
    '--pattern <glob>',
    'extra env basename glob; only effective with --with-env (repeatable)',
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .action(async (idOrName: string | undefined, opts: DownloadOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      const isCloud = (box.provider ?? 'docker') !== 'docker';

      if (isCloud) {
        // Cloud download (workspace): we don't have rsync over docker exec, so
        // gitignore-aware change-detection isn't wired. Fall back to a bulk
        // tar of `/workspace` via provider.downloadPath — overwrites the host
        // workspace dir. The user already gets git-aware sync-back via
        // `agentbox-ctl git push` inside the box for tracked files; this is
        // for grabbing untracked or env artifacts.
        if (opts.dryRun) {
          throw new Error('cloud download does not yet support --dry-run; omit to bulk-pull /workspace.');
        }
        if (!opts.respectGitignore || opts.includeNodeModules || opts.withEnv || opts.pattern.length > 0) {
          log.warn(
            'cloud download ignores gitignore/--with-env/--pattern filters in v1 — pulling the whole /workspace tree (Phase 6 polish).',
          );
        }
        if (!opts.yes) {
          const ok = await confirm({
            message: `Overwrite ${box.workspacePath} with the cloud box's /workspace contents?`,
            initialValue: false,
          });
          if (!ok) {
            log.info('cancelled');
            return;
          }
        }
        const provider = await providerForBox(box);
        if (!provider.downloadDirContents) {
          throw new Error(`provider '${provider.name}' does not support bulk workspace download`);
        }
        // Pull the *contents* of /workspace into box.workspacePath — files
        // land directly, not under a `workspace/` subdir.
        const result = await provider.downloadDirContents(
          box,
          '/workspace',
          box.workspacePath,
        );
        process.stdout.write(`downloaded /workspace contents to ${result.finalPath}\n`);
        return;
      }

      const insp = await inspectBox(box.id);
      if (insp.state === 'paused') {
        log.info('box is paused; unpausing');
        await unpauseBox(box.id);
      } else if (insp.state === 'stopped') {
        log.info('box is stopped; starting');
        await startBox(box.id);
      } else if (insp.state === 'missing') {
        throw new Error(`box ${box.name} has no container; was it destroyed?`);
      }

      const rootWorktree = box.gitWorktrees?.find((w) => w.kind === 'root');
      if (rootWorktree) {
        log.warn(
          `This box has been committing to branch \`${rootWorktree.branch}\` in a separate worktree.\n` +
            `For a git-aware merge instead of a file copy, run from your checkout:\n` +
            `  git merge ${rootWorktree.branch}\n` +
            `Continuing with rsync into ${box.workspacePath}`,
        );
      }

      const envPatterns = opts.withEnv
        ? [...DEFAULT_ENV_PATTERNS, ...opts.pattern]
        : undefined;

      const preview = await pullToHost(box, {
        dryRun: true,
        respectGitignore: opts.respectGitignore,
        includeNodeModules: opts.includeNodeModules,
        envPatterns,
        noRefresh: !opts.refresh,
      });

      if (preview.changes.length === 0) {
        process.stdout.write(`no changes to download into ${box.workspacePath}\n`);
        return;
      }

      if (opts.dryRun) {
        for (const line of preview.changes) process.stdout.write(`${line}\n`);
        process.stdout.write(
          `\n[dry-run] ${preview.changes.length} file(s) would change in ${box.workspacePath}\n`,
        );
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.changes.length} changed file(s)${opts.withEnv ? ' (incl. env/config)' : ''} into ${box.workspacePath}?`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullToHost(box, {
        dryRun: false,
        respectGitignore: opts.respectGitignore,
        includeNodeModules: opts.includeNodeModules,
        envPatterns,
        // The dry-run pass above already refreshed (or intentionally skipped)
        // the scratch dir — don't rsync box->scratch a second time.
        noRefresh: true,
      });
      process.stdout.write(
        `updated ${result.changes.length} file(s) in ${result.hostPath}` +
          `${result.usedGitignore ? '' : ' (exclude-list mode)'}\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });

// `agentbox download env [box]` — commander dispatches the `env` subcommand;
// `agentbox download [box]` / `agentbox download` still hit the default action above.
downloadCommand.addCommand(downloadEnvCommand);

// `agentbox download claude [box]` — box -> host pull of newly-added Claude
// skills/plugins/agents/commands (additive; reads the claude-config volume so
// the box need not be running).
downloadCommand.addCommand(downloadClaudeCommand);

// `agentbox download codex [box]` — box -> host pull of Codex config/auth
// (additive; reads the codex-config volume so the box need not be running).
downloadCommand.addCommand(downloadCodexCommand);

// `agentbox download opencode [box]` — box -> host pull of OpenCode config/auth
// (additive; reads the opencode-config volume so the box need not be running).
downloadCommand.addCommand(downloadOpencodeCommand);

// `agentbox download config [box]` — box -> host pull of just agentbox.yaml
// (gitignore-bypassing; for syncing back an in-box-edited/regenerated config).
downloadCommand.addCommand(downloadConfigCommand);
