import { confirm, isCancel, log } from '@agentbox/cli-kit';
import { Command } from 'commander';
import { join } from 'node:path';
import type { BoxRecord } from '@agentbox/core';
import {
  DEFAULT_ENV_PATTERNS,
  boxRunDirFor,
  inspectBox,
  pullToHost,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import {
  agentWorkspaceArtifactPaths,
  isAgentWorkspaceArtifact,
  parseItemizedEntries,
  pullWorkspaceToHost,
  type PullWorkspaceResult,
} from '@agentbox/sandbox-core';
import { prepareBackupDir, runBackup, resolveBackupTarget } from './_backup.js';
import { resolveBoxOrExit } from '../box-ref.js';
import { ensureBoxRunningVia } from '../lib/ensure-running.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';
import { downloadClaudeCommand } from './download-claude.js';
import { downloadCodexCommand } from './download-codex.js';
import { downloadOpencodeCommand } from './download-opencode.js';
import { downloadOpenclawCommand } from './download-openclaw.js';
import { downloadPiCommand } from './download-pi.js';
import { downloadConfigCommand } from './download-config.js';
import { downloadEnvCommand } from './download-env.js';

interface DownloadOpts {
  yes?: boolean;
  dryRun?: boolean;
  respectGitignore: boolean; // commander gives `--no-respect-gitignore` => false
  includeNodeModules?: boolean;
  includeAgentFiles?: boolean;
  refresh: boolean; // commander gives `--no-refresh` => false
  withEnv?: boolean;
  pattern: string[];
  backup?: boolean;
  name?: string;
  keep?: string;
  agent?: string;
}

/**
 * A box that commits on its own branch in a separate worktree can be merged
 * with git instead of copied; say so before we rsync over the working tree.
 */
function warnAboutRootWorktree(box: BoxRecord): void {
  const rootWorktree = box.gitWorktrees?.find((w) => w.kind === 'root');
  if (!rootWorktree) return;
  log.warn(
    `This box has been committing to branch \`${rootWorktree.branch}\` in a separate worktree.\n` +
      `For a git-aware merge instead of a file copy, run from your checkout:\n` +
      `  git merge ${rootWorktree.branch}\n` +
      `Continuing with rsync into ${box.workspacePath}`,
  );
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
    'force exclude-list mode (skip git ls-files) even in a git workspace',
  )
  .option(
    '--include-node-modules',
    'keep node_modules in the selection (both gitignore and exclude-list mode)',
  )
  .option(
    '--include-agent-files',
    "copy agent-generated workspace files (AGENTS.md, SOUL.md, ...) your project doesn't have",
  )
  .option('--no-refresh', "skip the box->scratch-dir staging step (use whatever's already there)")
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
  .option(
    '--backup',
    "capture the box into <project>/.agentbox/bots/<bot>/ instead of your working dir: the workspace plus the agent's state dir, identity included",
  )
  .option('--name <bot>', 'bot name for --backup (default: the box name)')
  .option('--keep <n>', 'backups to keep for --backup (default: 3)')
  .option('--agent <id>', "agent whose state --backup captures (default: the box's)")
  .action(async (idOrName: string | undefined, opts: DownloadOpts) => {
    try {
      let box = await resolveBoxOrExit(idOrName);
      const isCloud = (box.provider ?? 'docker') !== 'docker';
      const envPatterns = opts.withEnv ? [...DEFAULT_ENV_PATTERNS, ...opts.pattern] : undefined;

      // `--backup` is the SAME pull pointed somewhere else. Resolved before the
      // pull so a bad `--name`/`--keep`/`--agent` fails before the box is
      // started and a workspace is staged.
      const target = opts.backup ? resolveBackupTarget(box, opts) : undefined;
      const destDir = target ? target.workspaceDir : box.workspacePath;
      if (target) await prepareBackupDir(target);

      // One pull, two stage-1s. Docker materializes /workspace over its
      // /host-export bind mount; every other provider tars the selected files
      // out over the provider seam. Both then run the SAME host-side rsync
      // (`rsyncPullToHost`), which is what gives a cloud box `--dry-run`, the
      // itemized change list, and gitignore/exclude selection.
      let pull: (o: {
        dryRun: boolean;
        noRefresh: boolean;
        skipPaths?: readonly string[];
      }) => Promise<PullWorkspaceResult>;
      if (isCloud) {
        const provider = await providerForBox(box);
        box = await ensureBoxRunningVia(provider, box);
        const scratchDir = join(boxRunDirFor(box), 'workspace');
        pull = (o) =>
          pullWorkspaceToHost({
            provider,
            box,
            scratchDir,
            destDir,
            respectGitignore: opts.respectGitignore,
            includeNodeModules: opts.includeNodeModules,
            envPatterns,
            dryRun: o.dryRun,
            noRefresh: o.noRefresh,
            skipPaths: o.skipPaths,
          });
      } else {
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
        if (!target) warnAboutRootWorktree(box);
        pull = async (o) => {
          const r = await pullToHost(box, {
            dryRun: o.dryRun,
            destDir,
            respectGitignore: opts.respectGitignore,
            includeNodeModules: opts.includeNodeModules,
            envPatterns,
            noRefresh: o.noRefresh,
            skipPaths: o.skipPaths,
          });
          return {
            hostPath: r.hostPath,
            changes: r.changes,
            applied: r.applied,
            usedGitignore: r.usedGitignore,
            missing: r.missing,
          };
        };
      }

      const preview = await pull({ dryRun: true, noRefresh: !opts.refresh });

      // Files an agent generated in /workspace that the project does not have.
      // Keyed on CREATED, not on the name alone, so a file the user already has
      // is never questioned — it is theirs, and this is just an update to it.
      // A backup takes EVERYTHING — `SOUL.md` and `IDENTITY.md` are the point of
      // one, not a surprise to be asked about — so the question is skipped
      // there. It only makes sense when the destination is the user's project.
      const artifactNames = agentWorkspaceArtifactPaths();
      const newArtifacts = target
        ? []
        : parseItemizedEntries(preview.changes.join('\n'))
            .filter((e) => e.created && isAgentWorkspaceArtifact(e.path, artifactNames))
            .map((e) => e.path);

      if (preview.changes.length === 0) {
        process.stdout.write(
          `no changes to download into ${destDir}` +
            `${preview.usedGitignore ? '' : ' (exclude-list mode)'}\n`,
        );
        return;
      }

      if (opts.dryRun) {
        for (const line of preview.changes) process.stdout.write(`${line}\n`);
        process.stdout.write(
          `\n[dry-run] ${String(preview.changes.length)} file(s) would change in ` +
            `${destDir}${preview.usedGitignore ? '' : ' (exclude-list mode)'}\n`,
        );
        if (newArtifacts.length > 0 && !opts.includeAgentFiles) {
          process.stdout.write(
            `[dry-run] ${String(newArtifacts.length)} of them are agent-generated and ` +
              `you would be asked about them: ${newArtifacts.join(', ')}\n`,
          );
        }
        return;
      }

      // Asked BEFORE the main confirm, so the count the user approves is the
      // count that gets written.
      let skipPaths: string[] = [];
      if (newArtifacts.length > 0 && !opts.includeAgentFiles) {
        if (opts.yes) {
          skipPaths = newArtifacts;
        } else {
          const take = await confirm({
            message:
              `${String(newArtifacts.length)} file(s) your project doesn't have were generated ` +
              `by the agent (${newArtifacts.join(', ')}). Copy them in too?`,
            initialValue: false,
          });
          if (isCancel(take) || !take) skipPaths = newArtifacts;
        }
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: target
            ? `Back up ${String(preview.changes.length)} workspace file(s)` +
              `${target.agent ? ` and the ${target.agent} state dir (identity included)` : ''} ` +
              `into ${target.dir}?`
            : `Download ${String(preview.changes.length - skipPaths.length)} changed file(s)${opts.withEnv ? ' (incl. env/config)' : ''} into ${destDir}?`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      // The preview pass already refreshed (or intentionally skipped) the
      // scratch dir — don't restage a second time.
      const result = await pull({ dryRun: false, noRefresh: true, skipPaths });
      process.stdout.write(
        `${target ? 'backed up' : 'updated'} ${String(result.changes.length)} file(s) ` +
          `${target ? 'to' : 'in'} ${result.hostPath}` +
          `${result.usedGitignore ? '' : ' (exclude-list mode)'}\n`,
      );

      if (target) {
        const { manifest, pruned, wroteGitignore } = await runBackup({
          box,
          target,
          includeNodeModules: opts.includeNodeModules,
        });
        if (manifest.state) {
          process.stdout.write(
            `captured the ${String(manifest.agent)} state dir` +
              `${manifest.databases?.length ? ` (${String(manifest.databases.length)} database(s) via the SQLite backup API)` : ''}\n`,
          );
          // Not a footnote: this is a live gateway token sitting in the user's
          // project. It is 0600 and gitignored, but they should know it is there.
          process.stdout.write(
            `warning: ${join(target.dir, 'state')} holds this bot's IDENTITY (auth token, ` +
              `channel pairings). Keep it out of git and off shared drives.\n`,
          );
        } else if (target.agent) {
          process.stdout.write(`note: the ${target.agent} state dir was not captured\n`);
        } else {
          process.stdout.write('note: this box has no known agent; workspace only\n');
        }
        if (wroteGitignore) {
          process.stdout.write(`added .agentbox/ to ${join(target.projectRoot, '.gitignore')}\n`);
        }
        if (pruned.length > 0) {
          process.stdout.write(
            `pruned ${String(pruned.length)} older backup(s), keeping ${String(target.keep)}\n`,
          );
        }
        process.stdout.write(`latest -> ${target.stamp}\n`);
      }
      if (skipPaths.length > 0) {
        process.stdout.write(
          `skipped ${String(skipPaths.length)} agent-generated file(s) ` +
            `(${skipPaths.join(', ')}); --include-agent-files to take them\n`,
        );
      }
      // Selected but not staged: something changed in the box between the
      // listing and the staging, or the scratch dir is stale. Named, not fatal.
      if (result.missing.length > 0) {
        process.stdout.write(
          `note: ${String(result.missing.length)} selected file(s) were not in the staged copy ` +
            `(raced, or a stale --no-refresh scratch dir)\n`,
        );
      }
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

// `agentbox download pi [box]` — box -> host pull of Pi config/auth
// (additive; reads the pi-config volume so the box need not be running).
downloadCommand.addCommand(downloadPiCommand);

// `agentbox download openclaw [box]` — box -> host pull of the gateway's agent
// definitions only. The config and state are identity and are never pulled.
downloadCommand.addCommand(downloadOpenclawCommand);

// `agentbox download config [box]` — box -> host pull of just agentbox.yaml
// (gitignore-bypassing; for syncing back an in-box-edited/regenerated config).
downloadCommand.addCommand(downloadConfigCommand);
