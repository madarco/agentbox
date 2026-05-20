import { confirm, isCancel, log } from '@clack/prompts';
import { Command } from 'commander';
import {
  findProjectRoot,
  loadEffectiveConfig,
  setConfigValue,
  unsetConfigValue,
} from '@agentbox/config';
import {
  createCheckpoint,
  inspectBox,
  listCheckpoints,
  removeCheckpoint,
  startBox,
  unpauseBox,
} from '@agentbox/sandbox-docker';
import { resolveBoxOrExit } from '../box-ref.js';
import { handleLifecycleError } from './_errors.js';

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
        log.info(`make it the default for new boxes: agentbox checkpoint set-default ${info.name}`);
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
  .description('Capture and manage project checkpoints (warm box state new boxes can start from)')
  .addCommand(createSub, { isDefault: true })
  .addCommand(lsSub)
  .addCommand(setDefaultSub)
  .addCommand(rmSub);
