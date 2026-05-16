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
import {
  maybeRunSetupWizard,
  passthroughFlags,
  WIZARD_AUTOLAUNCH_ENV,
} from '../wizard.js';
import { claudeCommand } from './claude.js';

interface CreateOptions {
  workspace: string;
  name?: string;
  snapshot?: boolean; // commander: --snapshot / --no-snapshot => true / false / undefined
  image?: string;
  attach?: boolean;
  yes?: boolean;
  withPlaywright?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  sharedDockerCache?: boolean;
}

function buildCliOverrides(opts: CreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.snapshot !== undefined) box.snapshot = opts.snapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  return Object.keys(box).length > 0 ? { box } : {};
}

function resolveUseSnapshot(
  opts: CreateOptions,
  configDefault: boolean | undefined,
): boolean {
  // Mirrors `agentbox claude`: snapshot=on by default; explicit CLI flag wins,
  // then config layers. No interactive prompt — power users override via
  // `--no-snapshot` or `box.snapshot: false` in their config.
  if (opts.snapshot === false) return false;
  if (opts.snapshot === true) return true;
  return configDefault ?? true;
}

function attachShell(container: string): never {
  // execSync is fine here: we hand control to docker exec and exit on its exit.
  const child = spawnSync('docker', ['exec', '-it', container, 'bash'], {
    stdio: 'inherit',
  });
  process.exit(child.status ?? 0);
}

export const createCommand = new Command('create')
  .description('Create and start a new agent box (Docker container with FUSE overlay)')
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--snapshot', 'use a frozen APFS clone of the workspace as the overlay lower')
  .option('--no-snapshot', 'bind the live workspace directly (host edits leak into reads)')
  .option('--image <ref>', 'override the box image', undefined)
  .option('--attach', 'drop into a shell inside the box after it is ready')
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option(
    '--shared-docker-cache',
    "use the shared 'agentbox-docker-cache' volume for in-box docker images (preserved on destroy; only one box can run at a time when set)",
  )
  .option('-y, --yes', 'skip prompts, accept defaults (snapshot=on)')
  .action(async (opts: CreateOptions) => {
    intro('agentbox create');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;

    // First-run wizard: when no agentbox.yaml exists, optionally hand off to
    // `agentbox claude` so the agent can interactively generate one.
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'create',
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

    const useSnapshot = resolveUseSnapshot(opts, cfg.effective.box.snapshot);

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
        image: cfg.effective.box.image,
        withPlaywright,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
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
      log.info(`lower:     ${result.record.lowerPath}`);
      log.info(`upper:     ${result.record.upperVolume}`);
      if (result.record.snapshotDir) {
        log.info(`snapshot:  ${result.record.snapshotDir}`);
      }

      for (const check of result.overlayChecks) {
        log.success(`${check.name} — ${check.detail}`);
      }

      log.message(
        [
          '',
          'Try it:',
          `  docker exec -it ${result.record.container} bash`,
          `  docker exec ${result.record.container} ls /workspace`,
          '',
          'Destroy:',
          `  docker rm -f ${result.record.container}`,
          `  docker volume rm ${result.record.upperVolume} ${result.record.nodeModulesVolume}`,
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
