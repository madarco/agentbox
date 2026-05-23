import { confirm, isCancel, log } from '@clack/prompts';
import { Command } from 'commander';
import {
  findProjectRoot,
  loadEffectiveConfig,
  setConfigValue,
  unsetConfigValue,
} from '@agentbox/config';
import {
  clearRelayNotice,
  createCheckpoint,
  inspectBox,
  listCheckpoints,
  removeCheckpoint,
  setRelayNotice,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';
import { requireDockerProvider } from './_provider-guard.js';

/** Footer warning shown in attached sessions while a checkpoint runs. */
const CHECKPOINT_NOTICE = 'Checkpoint in progress — the box will be unresponsive for a moment';
/**
 * Notice TTL backstop: longer than the relay's checkpoint RPC timeout
 * (600s) so a stale notice self-clears even if this CLI is SIGKILLed
 * before its `finally` runs.
 */
const CHECKPOINT_NOTICE_TTL_MS = 660_000;

interface CreateOpts {
  name?: string;
  merged?: boolean;
  setDefault?: boolean;
  replace?: boolean;
}

async function projectRootFor(cwd: string, recordRoot?: string): Promise<string> {
  return recordRoot ?? (await findProjectRoot(cwd)).root;
}

const createSub = new Command('create')
  .description('Capture a box state as a project checkpoint (<box-name>-<n>)')
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--name <name>', 'checkpoint name (default: <box-name>-<next>)')
  .option('--merged', 'flatten lower+upper into one tree instead of a layered delta')
  .option('--set-default', 'mark this checkpoint as the project default for new boxes')
  .option(
    '--replace',
    "if a checkpoint with the same name exists, rm it first (idempotent recapture; safe to retry when the previous run's stdout was lost)",
  )
  .action(async (idOrName: string | undefined, opts: CreateOpts) => {
    try {
      const box = await resolveBoxOrExit(idOrName);
      requireDockerProvider(box, 'checkpoint create');

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

      const projectRoot = await projectRootFor(box.workspacePath, box.projectRoot);
      const cfg = await loadEffectiveConfig(projectRoot);

      // Warn attached sessions (agentbox claude footer / dashboard) that the
      // box is about to freeze — `docker commit` pauses the container. Best-
      // effort: a null id means the relay is down and there's nothing to clear.
      const noticeId = await setRelayNotice(
        box.id,
        'checkpoint',
        CHECKPOINT_NOTICE,
        CHECKPOINT_NOTICE_TTL_MS,
      );
      let signalled = false;
      const onSignal = (): void => {
        if (signalled) return;
        signalled = true;
        void (async () => {
          if (noticeId) await clearRelayNotice(box.id, noticeId);
          process.exit(130);
        })();
      };
      if (noticeId) {
        process.once('SIGINT', onSignal);
        process.once('SIGTERM', onSignal);
      }

      try {
        const info = await createCheckpoint({
          box,
          projectRoot,
          name: opts.name,
          merged: opts.merged === true,
          setDefault: opts.setDefault === true,
          replace: opts.replace === true,
          maxLayers: cfg.effective.checkpoint.maxLayers,
          onLog: (line) => log.info(line),
        });

        log.success(
          `checkpoint ${info.name} (${info.manifest.type}) -> ${info.dir}` +
            (opts.setDefault ? '  [project default]' : ''),
        );
        if (!opts.setDefault) {
          log.info(
            `make it the default for new boxes: agentbox checkpoint set-default ${info.name}`,
          );
        }
      } finally {
        if (noticeId) {
          await clearRelayNotice(box.id, noticeId);
          process.removeListener('SIGINT', onSignal);
          process.removeListener('SIGTERM', onSignal);
        }
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const lsSub = new Command('ls')
  .description('List this project\'s checkpoints')
  .action(async () => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      const cfg = await loadEffectiveConfig(projectRoot);
      const def = cfg.effective.box.defaultCheckpoint;
      const list = await listCheckpoints(projectRoot);
      if (list.length === 0) {
        process.stdout.write(`no checkpoints for ${projectRoot}\n`);
        return;
      }
      for (const c of list) {
        const flag = c.name === def ? ' *default' : '';
        process.stdout.write(
          `${c.name}  ${c.manifest.type}  from ${c.manifest.sourceBoxName}  ${c.manifest.createdAt}${flag}\n`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const setDefaultSub = new Command('set-default')
  .description('Pin a checkpoint as the project default (box.defaultCheckpoint)')
  .argument('[ref]', 'checkpoint name (omit with --clear)')
  .option('--clear', 'unset the project default instead of setting one')
  .action(async (ref: string | undefined, opts: { clear?: boolean }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      if (opts.clear) {
        if (ref !== undefined) {
          throw new Error('pass either a <ref> or --clear, not both');
        }
        const r = await unsetConfigValue('project', 'box.defaultCheckpoint', projectRoot);
        process.stdout.write(
          r.existed
            ? `cleared project default checkpoint   (wrote ${r.path})\n`
            : `no project default checkpoint was set   (${r.path})\n`,
        );
        return;
      }
      if (ref === undefined) {
        throw new Error('missing <ref> (or pass --clear to unset the default)');
      }
      const list = await listCheckpoints(projectRoot);
      if (!list.some((c) => c.name === ref)) {
        throw new Error(`checkpoint not found: ${ref} (see \`agentbox checkpoint ls\`)`);
      }
      const r = await setConfigValue('project', 'box.defaultCheckpoint', ref, projectRoot);
      process.stdout.write(`project default checkpoint = ${ref}   (wrote ${r.path})\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const rmSub = new Command('rm')
  .description('Delete a checkpoint')
  .argument('<ref>', 'checkpoint name')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (ref: string, opts: { yes?: boolean }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      if (!opts.yes) {
        const ok = await confirm({ message: `Delete checkpoint ${ref}?`, initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }
      const removed = await removeCheckpoint(projectRoot, ref);
      if (!removed) throw new Error(`checkpoint not found: ${ref}`);
      process.stdout.write(`removed checkpoint ${ref}\n`);

      // Don't leave box.defaultCheckpoint dangling at a now-deleted ref —
      // future `agentbox create` would fail to resolve it. Clear it when the
      // project layer pointed here; warn (can't auto-edit) if it came from a
      // global / workspace-defaults layer instead.
      const cfg = await loadEffectiveConfig(projectRoot);
      if (cfg.layers.project.values.box?.defaultCheckpoint === ref) {
        await unsetConfigValue('project', 'box.defaultCheckpoint', projectRoot);
        log.info(`cleared project default checkpoint (was ${ref})`);
      } else if (cfg.effective.box.defaultCheckpoint === ref) {
        log.warn(
          `default checkpoint ${ref} is set outside the per-project config (global or agentbox.yaml defaults) — clear it manually`,
        );
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

export const checkpointCommand = new Command('checkpoint')
  .alias('checkpoints')
  .description('List and manage project checkpoints (warm box state new boxes can start from)')
  .addCommand(createSub)
  .addCommand(lsSub, { isDefault: true })
  .addCommand(setDefaultSub)
  .addCommand(rmSub);
