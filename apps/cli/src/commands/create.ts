import { intro, log, outro, spinner } from '@clack/prompts';
import {
  bumpProjectGcCounter,
  findProjectRoot,
  loadEffectiveConfig,
  pruneOrphanProjectConfigs,
  type UserConfig,
} from '@agentbox/config';
import {
  DEFAULT_RELAY_PORT,
  detectEngine,
  listBoxes,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { execSync, spawnSync } from 'node:child_process';
import { clampSpinnerLine } from '../spinner-line.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { providerForCreate } from '../provider/registry.js';
import { resolveLimits } from '../limits.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import {
  maybeRunSetupWizard,
  passthroughFlags,
  serializeEnvFilesForEnv,
  WIZARD_AUTOLAUNCH_ENV,
  WIZARD_ENV_FILES_ENV,
} from '../wizard.js';
import { claudeCommand } from './claude.js';

interface CreateOptions {
  workspace: string;
  name?: string;
  /** Override the sandbox backend. Resolved via the provider registry. */
  provider?: string;
  hostSnapshot?: boolean; // commander: --host-snapshot / --no-host-snapshot => true / false / undefined
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  attach?: boolean;
  yes?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  sharedDockerCache?: boolean;
  portless?: boolean; // commander: --portless / --no-portless => true / false / undefined
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
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  return out;
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

const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

async function attachShell(record: BoxRecord): Promise<never> {
  const dockerArgv = ['exec', '-it', record.container, 'bash'];
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    // Non-TTY (scripted create --attach piping somewhere): preserve
    // bit-for-bit current behavior — the wrapper's own fallback would do
    // the same, but bypassing avoids the node-pty optional-dep load.
    const child = spawnSync('docker', dockerArgv, { stdio: 'inherit' });
    process.exit(child.status ?? 0);
  }
  const code = await runWrappedAttach({
    container: record.container,
    dockerArgv,
    relayBaseUrl: RELAY_HOST_URL,
    boxId: record.id,
    boxName: record.name,
    projectIndex: record.projectIndex,
    mode: 'shell',
  });
  process.exit(code);
}

export const createCommand = new Command('create')
  .description('Create and start a new agent box (Docker container with /workspace seeded via in-container git worktree)')
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option('--provider <name>', "sandbox backend: 'docker' (default) or 'daytona' (cloud)")
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
  .option(
    '--portless',
    'map the box web app to https://<name>.localhost via the Portless proxy (Docker Desktop)',
  )
  .option('--no-portless', 'do not register a Portless alias for this box')
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

    // Cloud providers don't use the Docker-only Portless proxy and would
    // hand off to `agentbox claude` (a Docker-only flow that ignores
    // --provider) via the setup wizard — skip both for non-docker providers
    // so `agentbox create --provider daytona` provisions a cloud box.
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    const isDocker = providerName === 'docker';

    const portlessEnabled = isDocker
      ? await maybePromptPortless({
          engine: await detectEngine(),
          enabled: cfg.effective.portless.enabled,
          yes: !!opts.yes,
          cwd: opts.workspace,
        })
      : undefined;

    // First-run wizard: when no agentbox.yaml exists, optionally hand off to
    // `agentbox claude` so the agent can interactively generate one. The
    // wizard runs for every provider — it's the env-file picker + first-run
    // claude offer, both of which are useful for cloud boxes too.
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'create',
      checkpointRef,
      provider: providerName,
      withEnv: cfg.effective.box.withEnv,
    });
    if (wiz.action === 'switch-to-claude' && isDocker) {
      // Docker: hand off to `agentbox claude` whose default action creates +
      // attaches in one go. For non-docker providers we fall through to the
      // normal create flow below and attach claude post-create, because
      // `agentbox claude`'s default action ignores --provider.
      process.env[WIZARD_AUTOLAUNCH_ENV] = '1';
      const serialized = serializeEnvFilesForEnv(wiz.envFilesToImport);
      if (serialized !== undefined) process.env[WIZARD_ENV_FILES_ENV] = serialized;
      try {
        await claudeCommand.parseAsync(passthroughFlags(opts), { from: 'user' });
      } finally {
        delete process.env[WIZARD_AUTOLAUNCH_ENV];
        delete process.env[WIZARD_ENV_FILES_ENV];
      }
      return;
    }
    // Cloud + switch-to-claude: provision the cloud box now, then attach
    // claude via the cloud SSH path once the box is ready.
    const attachClaudeAfter = wiz.action === 'switch-to-claude' && !isDocker;

    const useSnapshot = resolveUseSnapshot(opts, cfg.effective.box.hostSnapshot);

    const s = spinner();
    s.start('creating box');
    try {
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set in any layer.
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      // --provider flag wins over box.provider config. The registry hands back
      // a DockerProvider for 'docker' and (once Phase 5 wires it) a cloud
      // provider for 'daytona'; everything below is provider-neutral.
      const provider = await providerForCreate({ flag: opts.provider, config: cfg.effective });
      const result = await provider.create({
        workspacePath: opts.workspace,
        name: opts.name,
        checkpointRef,
        image: cfg.effective.box.image,
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        envFilesToImport: wiz.envFilesToImport,
        vnc: { enabled: cfg.effective.box.vnc },
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => s.message(clampSpinnerLine(line)),
        providerOptions: {
          useSnapshot,
          sharedCache: cfg.effective.box.dockerCacheShared,
          portless: portlessEnabled,
          portlessStateDir: cfg.effective.portless.stateDir || undefined,
        },
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

      const tryLines = isDocker
        ? [
            `  docker exec -it ${result.record.container} bash`,
            `  docker exec ${result.record.container} ls /workspace`,
          ]
        : [
            `  agentbox shell ${result.record.name}`,
            `  agentbox claude attach ${result.record.name}`,
            `  agentbox url ${result.record.name}`,
          ];
      log.message(
        [
          '',
          'Try it:',
          ...tryLines,
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

      // Cloud: when the wizard offered "switch to claude" and we accepted,
      // attach claude over SSH now that the box is provisioned. Docker takes
      // the redispatch-to-`agentbox claude` path above (which already
      // attaches), so this branch only fires for cloud providers.
      if (attachClaudeAfter) {
        const { cloudAgentAttach } = await import('./_cloud-attach.js');
        await cloudAgentAttach({
          box: result.record,
          binary: 'claude',
          sessionName: 'claude',
          mode: 'claude',
        });
        return;
      }

      if (opts.attach) {
        await attachShell(result.record);
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
