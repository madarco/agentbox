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
import { handleLifecycleError } from './_errors.js';

interface DownloadEnvOpts {
  yes?: boolean;
  dryRun?: boolean;
  pattern: string[];
  refresh: boolean; // commander gives `--no-refresh` => false
}

/**
 * rsync `-i` codes a brand-new file as `>f` followed by all `+` in the
 * attribute columns. The column count differs between rsync builds (macOS
 * emits 7, others 9), so match "all +" rather than a fixed width.
 */
function tagChange(line: string): string {
  const sp = line.indexOf(' ');
  const code = sp === -1 ? line : line.slice(0, sp);
  const path = sp === -1 ? '' : line.slice(sp + 1);
  const isNew = /^>f\++$/.test(code);
  return `  ${path} ${isNew ? '(new)' : '(overwrites host)'}`;
}

export const downloadEnvCommand = new Command('env')
  .description(
    'Download gitignored env/config files (.env*, .envrc, secrets.toml, agentbox.yaml, ...) box -> host',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--dry-run', "list matched files and exit; don't write")
  .option(
    '--pattern <glob>',
    'extra basename glob to match (repeatable, adds to defaults)',
    (v: string, acc: string[]) => [...acc, v],
    [] as string[],
  )
  .option('--no-refresh', 'skip the box->scratch-dir rsync step')
  .action(async (idOrName: string | undefined, opts: DownloadEnvOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);

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

      log.info(
        `env/config files bypass gitignore and copy directly into ${box.workspacePath}`,
      );

      const patterns = [...DEFAULT_ENV_PATTERNS, ...opts.pattern];

      const preview = await pullToHost(box, {
        dryRun: true,
        respectGitignore: false,
        envPatterns: patterns,
        noRefresh: !opts.refresh,
      });

      if (preview.changes.length === 0) {
        process.stdout.write(`no env/config files to download into ${box.workspacePath}\n`);
        return;
      }

      for (const line of preview.changes) process.stdout.write(`${tagChange(line)}\n`);

      if (opts.dryRun) {
        process.stdout.write(
          `\n[dry-run] ${preview.changes.length} env/config file(s) would change in ${box.workspacePath}\n`,
        );
        return;
      }

      if (!opts.yes) {
        const ok = await confirm({
          message: `Download ${preview.changes.length} env/config file(s) into ${box.workspacePath}? (existing files will be overwritten)`,
          initialValue: false,
        });
        if (!ok) {
          log.info('cancelled');
          return;
        }
      }

      const result = await pullToHost(box, {
        dryRun: false,
        respectGitignore: false,
        envPatterns: patterns,
        // The dry-run pass above already refreshed (or intentionally skipped)
        // the scratch dir — don't rsync box->scratch a second time.
        noRefresh: true,
      });
      process.stdout.write(
        `downloaded ${result.changes.length} env/config file(s) into ${result.hostPath}\n`,
      );
    } catch (err) {
      handleLifecycleError(err);
    }
  });
