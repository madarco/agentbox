import { confirm, isCancel, log } from '@clack/prompts';
import { Command } from 'commander';
import {
  defaultCheckpointConfigKey,
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  setConfigValue,
  unsetConfigValue,
} from '@agentbox/config';
import type { ProviderKind } from '@agentbox/config';
import type { BoxRecord } from '@agentbox/core';
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
import { listCloudCheckpoints, resolveCloudCheckpoint } from '@agentbox/sandbox-cloud';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import { handleLifecycleError } from './_errors.js';

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
      const providerName = box.provider ?? 'docker';

      if (providerName !== 'docker') {
        await runCloudCheckpointCreate(box, opts);
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
  .description("List this project's checkpoints (both docker and cloud)")
  .action(async () => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      const cfg = await loadEffectiveConfig(projectRoot);
      // Resolve per-provider so the `*default` marker tracks which one the
      // wizard would actually pick for that provider's row.
      const defDocker = resolveDefaultCheckpoint(cfg.effective, 'docker');
      const defDaytona = resolveDefaultCheckpoint(cfg.effective, 'daytona');
      const dockerList = await listCheckpoints(projectRoot);
      // Merge in cloud-backend checkpoints. v1: only Daytona is known. Future
      // backends slot in here once they implement `createSnapshot`.
      const daytonaList = await listCloudCheckpoints(projectRoot, 'daytona');

      if (dockerList.length === 0 && daytonaList.length === 0) {
        process.stdout.write(`no checkpoints for ${projectRoot}\n`);
        return;
      }
      for (const c of dockerList) {
        const flag = c.name === defDocker ? ' *default' : '';
        process.stdout.write(
          `${c.name}  docker (${c.manifest.type})  from ${c.manifest.sourceBoxName}  ${c.manifest.createdAt}${flag}\n`,
        );
      }
      for (const c of daytonaList) {
        const flag = c.name === defDaytona ? ' *default' : '';
        process.stdout.write(
          `${c.name}  daytona (snapshot)  from ${c.manifest.sourceBoxName}  ${c.manifest.createdAt}${flag}\n`,
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
  .option(
    '--provider <name>',
    'set the default for only this provider (docker|daytona); without it, sets the cross-provider fallback',
  )
  .action(async (ref: string | undefined, opts: { clear?: boolean; provider?: string }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      const providerArg = opts.provider as ProviderKind | undefined;
      if (providerArg !== undefined && providerArg !== 'docker' && providerArg !== 'daytona') {
        throw new Error(`unknown provider '${opts.provider ?? ''}' (known: docker, daytona)`);
      }
      const configKey = defaultCheckpointConfigKey(providerArg);
      const label = providerArg ? `${providerArg} default checkpoint` : 'project default checkpoint';
      if (opts.clear) {
        if (ref !== undefined) {
          throw new Error('pass either a <ref> or --clear, not both');
        }
        const r = await unsetConfigValue('project', configKey, projectRoot);
        process.stdout.write(
          r.existed
            ? `cleared ${label}   (wrote ${r.path})\n`
            : `no ${label} was set   (${r.path})\n`,
        );
        return;
      }
      if (ref === undefined) {
        throw new Error('missing <ref> (or pass --clear to unset the default)');
      }
      // Accept the name if it exists in the store(s) we'd resolve against.
      // For --provider, restrict to that provider's store; without --provider,
      // accept if EITHER store has it (matches existing back-compat behavior).
      const checkDocker = providerArg === undefined || providerArg === 'docker';
      const checkDaytona = providerArg === undefined || providerArg === 'daytona';
      const dockerList = checkDocker ? await listCheckpoints(projectRoot) : [];
      const daytonaList = checkDaytona ? await listCloudCheckpoints(projectRoot, 'daytona') : [];
      if (
        !dockerList.some((c) => c.name === ref) &&
        !daytonaList.some((c) => c.name === ref)
      ) {
        throw new Error(`checkpoint not found: ${ref} (see \`agentbox checkpoint ls\`)`);
      }
      const r = await setConfigValue('project', configKey, ref, projectRoot);
      process.stdout.write(`${label} = ${ref}   (wrote ${r.path})\n`);
    } catch (err) {
      handleLifecycleError(err);
    }
  });

const rmSub = new Command('rm')
  .description('Delete a checkpoint (any provider that has it)')
  .argument('<ref>', 'checkpoint name')
  .option('-y, --yes', 'skip the confirmation prompt')
  .option('--provider <name>', "delete only from this provider's store (default: all)")
  .action(async (ref: string, opts: { yes?: boolean; provider?: string }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      // Look up both stores so the confirm + removal can act on whichever has it.
      const dockerInfo = !opts.provider || opts.provider === 'docker';
      const daytonaInfo =
        (!opts.provider || opts.provider === 'daytona') &&
        (await resolveCloudCheckpoint(projectRoot, 'daytona', ref));

      if (!opts.yes) {
        const ok = await confirm({ message: `Delete checkpoint ${ref}?`, initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }
      let any = false;
      if (dockerInfo) {
        const removed = await removeCheckpoint(projectRoot, ref);
        if (removed) {
          any = true;
          process.stdout.write(`removed docker checkpoint ${ref}\n`);
        }
      }
      if (daytonaInfo) {
        const { daytonaProvider } = await import('@agentbox/sandbox-daytona');
        try {
          await daytonaProvider.checkpoint?.remove(projectRoot, ref);
          any = true;
          process.stdout.write(`removed daytona checkpoint ${ref}\n`);
        } catch (err) {
          log.warn(
            `daytona checkpoint remove failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (!any) throw new Error(`checkpoint not found: ${ref}`);

      // Don't leave any default-checkpoint pointer dangling at a now-deleted
      // ref — future `agentbox create` would fail to resolve it. Sweep the
      // global + per-provider keys, clear whichever the project layer set
      // to this ref, warn if the dangling pointer lives in a layer we can't
      // auto-edit (global or agentbox.yaml defaults).
      const cfg = await loadEffectiveConfig(projectRoot);
      const projectBox = cfg.layers.project.values.box;
      const defKeys = [
        ['box.defaultCheckpoint', projectBox?.defaultCheckpoint, cfg.effective.box.defaultCheckpoint],
        ['box.defaultCheckpointDocker', projectBox?.defaultCheckpointDocker, cfg.effective.box.defaultCheckpointDocker],
        ['box.defaultCheckpointDaytona', projectBox?.defaultCheckpointDaytona, cfg.effective.box.defaultCheckpointDaytona],
      ] as const;
      for (const [key, projectValue, effectiveValue] of defKeys) {
        if (projectValue === ref) {
          await unsetConfigValue('project', key, projectRoot);
          log.info(`cleared project ${key} (was ${ref})`);
        } else if (effectiveValue === ref) {
          log.warn(
            `${key} = ${ref} is set outside the per-project config (global or agentbox.yaml defaults) — clear it manually`,
          );
        }
      }
    } catch (err) {
      handleLifecycleError(err);
    }
  });

/**
 * Cloud checkpoint create: delegate to `provider.checkpoint.create`. The cloud
 * provider's implementation captures via the backend's `createSnapshot` and
 * writes the manifest under `~/.agentbox/cloud-checkpoints/<backend>/…`.
 * Unlike Docker, there's no `--merged` (Daytona snapshots are flattened by
 * construction) and no `--replace` rerun yet (the underlying snapshot delete
 * is async on Daytona's side — keep it explicit: `agentbox checkpoint rm <name>`
 * then re-create).
 */
async function runCloudCheckpointCreate(box: BoxRecord, opts: CreateOpts): Promise<void> {
  if (opts.merged) {
    log.warn('--merged is Docker-only (cloud snapshots are always flattened); ignoring');
  }
  const projectRoot = await projectRootFor(box.workspacePath, box.projectRoot);
  const name = opts.name ?? `${box.name}-${String(Date.now()).slice(-6)}`;

  // Make sure the sandbox is running — `_experimental_createSnapshot` requires
  // a started sandbox. The provider's `probeState` + `start` handles the
  // pause/stop/missing branches with the same shape `agentbox url` / `screen`
  // use today.
  const provider = await providerForBox(box);
  const state = await provider.probeState(box);
  if (state === 'paused') {
    log.info('box is paused; resuming');
    await provider.resume(box);
  } else if (state === 'stopped') {
    log.info('box is stopped; starting');
    await provider.start(box);
  } else if (state === 'missing') {
    throw new Error(`cloud sandbox for ${box.name} is missing; was it deleted?`);
  }

  if (!provider.checkpoint) {
    throw new Error(`provider '${box.provider ?? 'docker'}' doesn't support checkpoints`);
  }

  // Daytona's snapshot capture pauses the sandbox while writing the image.
  // Warn attached sessions the same way the docker path does.
  const noticeId = await setRelayNotice(
    box.id,
    'checkpoint',
    CHECKPOINT_NOTICE,
    CHECKPOINT_NOTICE_TTL_MS,
  );
  try {
    log.info(`capturing cloud snapshot '${name}' (this may take a few minutes)`);
    const result = await provider.checkpoint.create(box, name);
    log.success(`checkpoint ${result.ref} (daytona snapshot) captured`);
    if (opts.setDefault) {
      // Cloud snapshots aren't usable by docker boxes — pin the daytona-
      // specific default so `agentbox create --provider docker` in the same
      // project doesn't trip over a snapshot it can't resolve.
      const key = defaultCheckpointConfigKey(box.provider ?? 'daytona');
      await setConfigValue('project', key, result.ref, projectRoot);
      log.info(`set project default checkpoint (${key}) -> ${result.ref}`);
    } else {
      log.info(
        `make it the default for new boxes: agentbox checkpoint set-default --provider ${box.provider ?? 'daytona'} ${result.ref}`,
      );
    }
  } finally {
    if (noticeId) await clearRelayNotice(box.id, noticeId);
  }
}

export const checkpointCommand = new Command('checkpoint')
  .alias('checkpoints')
  .description('List and manage project checkpoints (warm box state new boxes can start from)')
  .addCommand(createSub)
  .addCommand(lsSub, { isDefault: true })
  .addCommand(setDefaultSub)
  .addCommand(rmSub);
