import { intro, log, outro, spinner } from '@clack/prompts';
import {
  bumpProjectGcCounter,
  findProjectRoot,
  loadEffectiveConfig,
  pruneOrphanProjectConfigs,
  type UserConfig,
} from '@agentbox/config';
import { createBox, listBoxes } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { execSync, spawnSync } from 'node:child_process';
import { clampSpinnerLine } from '../spinner-line.js';
import { resolveLimits } from '../limits.js';
import {
  maybeRunSetupWizard,
  passthroughFlags,
  WIZARD_AUTOLAUNCH_ENV,
} from '../wizard.js';
import { claudeCommand } from './claude.js';

interface CreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean; // commander: --host-snapshot / --no-host-snapshot => true / false / undefined
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  attach?: boolean;
  yes?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  sharedDockerCache?: boolean;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
}

function buildCliOverrides(opts: CreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  return Object.keys(box).length > 0 ? { box } : {};
}

function resolveUseSnapshot(
  opts: CreateOptions,
  configDefault: boolean | undefined,
): boolean {
  // host-snapshot used to be on by default because the snapshot was the
  // overlay lower (the box read directly from it). With the new model the
  // snapshot is only the tar-pipe source for the no-git case, so default off:
  // the live host workspace is a fine source for a 1-2s tar pipe. Users who
  // want the clone-then-tar dance still get it via `--host-snapshot` or
  // `box.hostSnapshot: true`.
  if (opts.hostSnapshot === false) return false;
  if (opts.hostSnapshot === true) return true;
  return configDefault ?? false;
}

/**
 * Checkpoint to start from: explicit `--snapshot <ref>` wins, else the
 * project's `box.defaultCheckpoint` (empty string = none).
 */
function resolveCheckpointRef(
  opts: CreateOptions,
  configDefault: string,
): string | undefined {
  if (opts.snapshot && opts.snapshot.length > 0) return opts.snapshot;
  return configDefault.length > 0 ? configDefault : undefined;
}

function attachShell(container: string): never {
  // execSync is fine here: we hand control to docker exec and exit on its exit.
  const child = spawnSync('docker', ['exec', '-it', container, 'bash'], {
    stdio: 'inherit',
  });
  process.exit(child.status ?? 0);
}

export const createCommand = new Command('create')
  .description('Create and start a new agent box (Docker container with /workspace seeded via in-container git worktree)')
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--host-snapshot', 'APFS-clone the host workspace into a per-box scratch dir before seeding /workspace (stabilizes the tar-pipe source)')
  .option('--no-host-snapshot', 'bind the live workspace directly (host edits leak into reads)')
  .option(
    '--snapshot <ref>',
    'start from a project checkpoint (see `agentbox checkpoint`); overrides box.defaultCheckpoint',
  )
  .option('--image <ref>', 'override the box image', undefined)
  .option('--attach', 'drop into a shell inside the box after it is ready')
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option(
    '--with-env',
    'copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at create time (gitignore-bypassing)',
  )
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option(
    '--shared-docker-cache',
    "use the shared 'agentbox-docker-cache' volume for in-box docker images (preserved on destroy; only one box can run at a time when set)",
  )
  .option('--memory <size>', 'memory ceiling (e.g. 512m, 2g); unset = unlimited')
  .option('--cpus <n>', 'CPU count cap (fractional ok, e.g. 1.5); unset = unlimited')
  .option('--pids-limit <n>', 'max process count (PIDs cgroup); unset = unlimited')
  .option('--disk <size>', 'best-effort container writable-layer size (e.g. 10g); no-op on overlay2/macOS')
  .option('-y, --yes', 'skip prompts, accept defaults')
  .action(async (opts: CreateOptions) => {
    intro('Setting up a new box...');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    const checkpointRef = resolveCheckpointRef(opts, cfg.effective.box.defaultCheckpoint);

    // First-run wizard: when no agentbox.yaml exists, optionally hand off to
    // `agentbox claude` so the agent can interactively generate one. Skipped
    // when starting from a checkpoint (it already carries the config).
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'create',
      checkpointRef,
    });
    if (wiz.action === 'switch-to-claude') {
      process.env[WIZARD_AUTOLAUNCH_ENV] = '1';
      try {
        await claudeCommand.parseAsync(passthroughFlags(opts), { from: 'user' });
      } finally {
        delete process.env[WIZARD_AUTOLAUNCH_ENV];
      }
      return;
    }

    const useSnapshot = resolveUseSnapshot(opts, cfg.effective.box.hostSnapshot);

    const s = spinner();
    s.start('creating box');
    try {
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set in any layer.
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        checkpointRef,
        image: cfg.effective.box.image,
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => s.message(clampSpinnerLine(line)),
      });
      s.stop(`box ${result.record.container} ready`);

      log.info(`id:        ${result.record.id}`);
      if (typeof result.record.projectIndex === 'number') {
        log.info(`n:         ${String(result.record.projectIndex)}   (in ${projectRoot})`);
      }
      log.info(`container: ${result.record.container}`);
      log.info(`image:     ${result.record.image}${result.imageBuilt ? ' (built just now)' : ''}`);
      if (result.record.snapshotDir) {
        log.info(`snapshot:  ${result.record.snapshotDir}`);
      }
      if (result.record.checkpointSource) {
        log.info(
          `checkpoint: ${result.record.checkpointSource.ref} (${result.record.checkpointSource.type}) → ${result.record.checkpointImage ?? '(missing)'}`,
        );
      }

      log.message(
        [
          '',
          'Try it:',
          `  docker exec -it ${result.record.container} bash`,
          `  docker exec ${result.record.container} ls /workspace`,
          '',
          'Destroy:',
          `  agentbox destroy ${result.record.name}`,
        ].join('\n'),
      );

      // Periodic best-effort housekeeping: every Nth create, reap per-project
      // config dirs whose source workspace folder was deleted. Must never fail
      // or slow down create.
      const m = cfg.effective.maintenance;
      if (m.pruneProjectConfigs) {
        try {
          const n = await bumpProjectGcCounter();
          if (n % m.pruneProjectConfigsEvery === 0) {
            const boxes = await listBoxes();
            const protectedPaths = boxes
              .map((b) => b.projectRoot)
              .filter((p): p is string => typeof p === 'string');
            const res = await pruneOrphanProjectConfigs({ protectedPaths });
            if (res.removed.length > 0) {
              log.info(
                `cleaned ${String(res.removed.length)} orphan project config dir(s): ` +
                  res.removed.map((r) => r.originalPath).join(', '),
              );
            }
          }
        } catch {
          /* best-effort: project-config GC must never break create */
        }
      }

      outro('done');

      if (opts.attach) {
        attachShell(result.record.container);
      }
    } catch (err) {
      s.stop('failed');
      const msg = err instanceof Error ? err.message : String(err);
      log.error(msg);
      // Help the user clean up partial state.
      try {
        const running = execSync('docker ps --format "{{.Names}}"', {
          stdio: ['ignore', 'pipe', 'ignore'],
        })
          .toString()
          .split('\n')
          .filter((n) => n.startsWith('agentbox-'));
        if (running.length > 0) {
          log.warn(`leftover containers: ${running.join(', ')}`);
          log.warn(`remove with: docker rm -f ${running.join(' ')}`);
        }
      } catch {
        /* best-effort */
      }
      process.exit(1);
    }
  });
