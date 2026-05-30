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

/** Cloud backends that store snapshots under ~/.agentbox/cloud-checkpoints/<backend>/. */
const CLOUD_BACKENDS = ['daytona', 'hetzner', 'vercel'] as const;
type CloudBackend = (typeof CLOUD_BACKENDS)[number];

/** Lazily resolve a cloud provider's checkpoint capability (dynamic import keeps SDKs out of the hot path). */
async function cloudProviderFor(backend: CloudBackend): Promise<import('@agentbox/core').Provider> {
  switch (backend) {
    case 'daytona':
      return (await import('@agentbox/sandbox-daytona')).daytonaProvider;
    case 'hetzner':
      return (await import('@agentbox/sandbox-hetzner')).hetznerProvider;
    case 'vercel':
      return (await import('@agentbox/sandbox-vercel')).vercelProvider;
  }
}

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
  yes?: boolean;
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
  .option('-y, --yes', 'skip the vercel "box will reboot" confirmation prompt')
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
      const dockerList = await listCheckpoints(projectRoot);
      // Merge in cloud-backend checkpoints. Each cloud provider stores its
      // snapshots under ~/.agentbox/cloud-checkpoints/<backend>/.
      const cloudLists = await Promise.all(
        CLOUD_BACKENDS.map(async (backend) => ({
          backend,
          def: resolveDefaultCheckpoint(cfg.effective, backend),
          items: await listCloudCheckpoints(projectRoot, backend),
        })),
      );

      const totalCloud = cloudLists.reduce((n, c) => n + c.items.length, 0);
      if (dockerList.length === 0 && totalCloud === 0) {
        process.stdout.write(`no checkpoints for ${projectRoot}\n`);
        return;
      }
      for (const c of dockerList) {
        const flag = c.name === defDocker ? ' *default' : '';
        process.stdout.write(
          `${c.name}  docker (${c.manifest.type})  from ${c.manifest.sourceBoxName}  ${c.manifest.createdAt}${flag}\n`,
        );
      }
      for (const { backend, def, items } of cloudLists) {
        for (const c of items) {
          const flag = c.name === def ? ' *default' : '';
          process.stdout.write(
            `${c.name}  ${backend} (snapshot)  from ${c.manifest.sourceBoxName}  ${c.manifest.createdAt}${flag}\n`,
          );
        }
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
    'set the default for only this provider (docker|daytona|hetzner|vercel); without it, sets the cross-provider fallback',
  )
  .action(async (ref: string | undefined, opts: { clear?: boolean; provider?: string }) => {
    try {
      const projectRoot = (await findProjectRoot(process.cwd())).root;
      const providerArg = opts.provider as ProviderKind | undefined;
      const knownProviders: ProviderKind[] = ['docker', ...CLOUD_BACKENDS];
      if (providerArg !== undefined && !knownProviders.includes(providerArg)) {
        throw new Error(
          `unknown provider '${opts.provider ?? ''}' (known: ${knownProviders.join(', ')})`,
        );
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
      // accept if ANY store has it (matches existing back-compat behavior).
      const dockerHit =
        (providerArg === undefined || providerArg === 'docker') &&
        (await listCheckpoints(projectRoot)).some((c) => c.name === ref);
      let cloudHit = false;
      for (const backend of CLOUD_BACKENDS) {
        if (providerArg !== undefined && providerArg !== backend) continue;
        if (await resolveCloudCheckpoint(projectRoot, backend, ref)) {
          cloudHit = true;
          break;
        }
      }
      if (!dockerHit && !cloudHit) {
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
      // Look up every store so the confirm + removal can act on whichever has
      // it. Docker is always a candidate (removeCheckpoint no-ops if absent);
      // cloud stores are pre-resolved so we only act on backends that have it.
      const wantDocker = !opts.provider || opts.provider === 'docker';
      const cloudHits: CloudBackend[] = [];
      for (const backend of CLOUD_BACKENDS) {
        if (opts.provider && opts.provider !== backend) continue;
        if (await resolveCloudCheckpoint(projectRoot, backend, ref)) cloudHits.push(backend);
      }

      if (!opts.yes) {
        const ok = await confirm({ message: `Delete checkpoint ${ref}?`, initialValue: false });
        if (isCancel(ok) || !ok) {
          log.info('cancelled');
          return;
        }
      }
      let any = false;
      if (wantDocker) {
        const removed = await removeCheckpoint(projectRoot, ref);
        if (removed) {
          any = true;
          process.stdout.write(`removed docker checkpoint ${ref}\n`);
        }
      }
      for (const backend of cloudHits) {
        try {
          const provider = await cloudProviderFor(backend);
          await provider.checkpoint?.remove(projectRoot, ref);
          any = true;
          process.stdout.write(`removed ${backend} checkpoint ${ref}\n`);
        } catch (err) {
          log.warn(
            `${backend} checkpoint remove failed: ${err instanceof Error ? err.message : String(err)}`,
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
        ['box.defaultCheckpointHetzner', projectBox?.defaultCheckpointHetzner, cfg.effective.box.defaultCheckpointHetzner],
        ['box.defaultCheckpointVercel', projectBox?.defaultCheckpointVercel, cfg.effective.box.defaultCheckpointVercel],
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

  // Vercel snapshots stop + reboot the box (the live tmux/agent process doesn't
  // survive; on-disk state does). Warn + confirm before yanking it. Only for a
  // direct host invocation with a TTY — the relay spawns this same command
  // headless for the in-box trigger (stdin ignored → isTTY false), and that
  // path is already gated by a wrapper-visible prompt in the relay. Other
  // providers snapshot without stopping, so they stay prompt-free.
  if ((box.provider ?? 'docker') === 'vercel' && !opts.yes && process.stdin.isTTY) {
    const ok = await confirm({
      message: 'Create checkpoint? The vercel box will stop and reboot.',
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      log.info('cancelled');
      return;
    }
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
    // When this checkpoint becomes the project default, capture the box's
    // agent login(s) back to the host (~/.agentbox) BEFORE the snapshot — the
    // box is guaranteed running here; the snapshot may pause it. Cloud has no
    // shared volume, so a login made inside the box would otherwise be lost on
    // destroy; mirroring it lets the next box (seeded by the cloud push)
    // inherit it. Best-effort — never blocks the checkpoint.
    if (opts.setDefault && provider.extractAgentCredentials) {
      try {
        const saved = await provider.extractAgentCredentials(box);
        if (saved.length > 0) {
          log.info(`saved ${saved.join(', ')} login to ~/.agentbox for future boxes`);
        }
      } catch (err) {
        log.warn(`agent credential extract skipped: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

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
