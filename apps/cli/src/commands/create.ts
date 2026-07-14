import { intro, log, outro } from '@clack/prompts';
import {
  bumpProjectGcCounter,
  findProjectRoot,
  loadEffectiveConfig,
  pruneOrphanProjectConfigs,
  registerProject,
  resolveBoxImage,
  resolveDefaultCheckpoint,
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
import { runCarryGate } from '../lib/carry-gate.js';
import { resolveGitCredsCarry } from '../lib/git-creds-gate.js';
import { cloudSizingProviderOptions } from '../lib/cloud-sizing.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../lib/from-branch.js';
import { openCommandLog } from '../lib/log-file.js';
import { makeProgressReporter } from '../lib/progress.js';
import { autoWriteSshConfig } from '@agentbox/sandbox-core';
import { maybePromptPortless, setupPortlessHost } from '../portless-prompt.js';
import { providerForCreate } from '../provider/registry.js';
import { parseProviderSpec } from '../provider/spec.js';
import { buildResyncWarning } from '../lib/resync-warning.js';
import { resolveLimits } from '../limits.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import {
  maybeRunSetupWizard,
  passthroughFlags,
  serializeEnvFilesForEnv,
  WIZARD_AUTOLAUNCH_ENV,
  WIZARD_ENV_FILES_ENV,
  WIZARD_RECREATE_ENV,
} from '../wizard.js';
import { evaluateBaseFreshness } from '../checkpoint-lookup.js';
import { runPrepare } from './prepare.js';
import { claudeCommand } from './claude.js';
import { resolveCustodyTarget } from './control-plane.js';
import { enqueueCreateViaHub, pollHubJob } from '../control-plane/hub-enqueue.js';

interface CreateOptions {
  workspace: string;
  name?: string;
  /** Override the sandbox backend. Resolved via the provider registry. */
  provider?: string;
  hostSnapshot?: boolean; // commander: --host-snapshot / --no-host-snapshot => true / false / undefined
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  /** --build / --no-pull: force a local docker base-image build instead of pulling from the registry. */
  build?: boolean;
  attach?: boolean;
  yes?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** --carry-yes (or AGENTBOX_CARRY_YES=1): auto-approve the carry: block prompt. */
  carryYes?: boolean;
  /** --carry <mode>: 'skip' disables carry for this run (also AGENTBOX_CARRY=skip). */
  carry?: 'skip' | 'ask';
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  resync?: boolean; // commander: --no-resync => false; default true (config box.resyncOnStart)
  sharedDockerCache?: boolean;
  portless?: boolean; // commander: --portless / --no-portless => true / false / undefined
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** --bundle-depth <n>: cap commits in the cloud-seed git bundle. 0 = full history. */
  bundleDepth?: number;
  /** --size <spec>: VM size for cloud providers. Hetzner: server type (cx33); Daytona: cpu-mem-disk GB (4-8-20); Vercel: vCPUs (4). */
  size?: string;
  /** --location <name>: Hetzner datacenter (nbg1, fsn1, hel1, ash). Hetzner-only. */
  location?: string;
  /** --inbound <spec>: VPS firewall access policy (locked | open | CIDR list). Hetzner/DigitalOcean-only. */
  inbound?: string;
  /** --remote-host <dest>: SSH destination whose docker engine runs the box. remote-docker-only. */
  remoteHost?: string;
  /** --from-branch <ref>: base the box's per-box branch on this ref (branch / tag / SHA) instead of HEAD. */
  fromBranch?: string;
  /** -b / --use-branch <name>: reuse an existing branch directly instead of forking agentbox/<name>. */
  useBranch?: string;
  /** -v / --verbose: also stream raw build / provision output to stderr. */
  verbose?: boolean;
  /** --no-credential-sync => false; default true (config box.credentialSync). */
  credentialSync?: boolean;
  /** --dangerously-with-credentials: copy a git credential into the box (git.pushMode=direct); cloud only.
   *  The token-vs-SSH choice is made ONLY at the interactive prompt (TTY required). */
  dangerouslyWithCredentials?: boolean;
  /** --via-hub: enqueue the create on the control box instead of building locally. */
  viaHub?: boolean;
  /** --url <url>: control-plane URL for --via-hub (else relay.controlPlaneUrl). */
  url?: string;
}

function buildCliOverrides(opts: CreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  // --image is resolved at the call site (alongside --snapshot / --size) so a
  // CLI flag beats project-level per-provider `box.image<Provider>` keys.
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  if (opts.credentialSync === false) box.credentialSync = false;
  if (opts.bundleDepth !== undefined) box.bundleDepth = opts.bundleDepth;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  // --dangerously-with-credentials selects the direct push mode (box holds a copy of your
  // git credentials). The actual copy is gated by a choice prompt later.
  if (opts.dangerouslyWithCredentials) out.git = { pushMode: 'direct' };
  return out;
}

function resolveUseSnapshot(opts: CreateOptions, configDefault: boolean | undefined): boolean {
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
function resolveCheckpointRef(opts: CreateOptions, configDefault: string): string | undefined {
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

/** The project's `origin` remote URL — the repo the hub worker clones VPS-side. */
function originUrl(projectRoot: string): string | null {
  try {
    return execSync('git config --get remote.origin.url', { cwd: projectRoot }).toString().trim() || null;
  } catch {
    return null;
  }
}

/**
 * `--via-hub` path: enqueue a create job on the control box and stream its
 * progress. Never touches a local provider. Exits the process with the job's
 * outcome (0 on done, 1 on failure), mirroring how the local path exits.
 */
async function runCreateViaHub(
  opts: CreateOptions,
  providerName: string,
  projectRoot: string,
  cmdLog: ReturnType<typeof openCommandLog>,
): Promise<void> {
  if (providerName === 'docker') {
    log.error('--via-hub needs a cloud provider (a docker box runs on this machine). Try --provider hetzner|e2b|vercel|daytona.');
    cmdLog.close();
    process.exit(1);
  }
  const repoUrl = originUrl(projectRoot);
  if (!repoUrl) {
    log.error('--via-hub needs a git `origin` remote (the hub worker clones it VPS-side). None found in this project.');
    cmdLog.close();
    process.exit(1);
  }
  const target = await resolveCustodyTarget(opts.url);
  if (!target) {
    cmdLog.close();
    process.exit(1);
  }
  const request = {
    repoUrl,
    provider: providerName,
    branch: opts.fromBranch?.trim() || undefined,
    name: opts.name?.trim() || undefined,
  };
  try {
    const jobId = await enqueueCreateViaHub(target, request);
    log.info(`enqueued on the control plane (job ${jobId})`);
    const job = await pollHubJob(target, jobId, {
      onStatus: (j) => log.step(`job ${jobId}: ${j.status}`),
    });
    if (job.status === 'done') {
      outro(`box created on the control plane: ${job.result?.boxId ?? '(id pending)'}`);
      cmdLog.close();
      process.exit(0);
    }
    log.error(`create job failed: ${job.result?.error ?? 'unknown error'}`);
    cmdLog.close();
    process.exit(1);
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    cmdLog.close();
    process.exit(1);
  }
}

export const createCommand = new Command('create')
  .description(
    'Create and start a new agent box (Docker container with /workspace seeded via in-container git worktree)',
  )
  .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
  .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
  .option(
    '--provider <name>',
    "sandbox backend: docker (default), daytona, hetzner, digitalocean, vercel, e2b, remote-docker. `docker:<host>` runs the box on that machine's docker engine over SSH.",
  )
  .option(
    '--remote-host <dest>',
    'SSH destination whose docker engine runs the box — an ~/.ssh/config alias or [user@]host[:port]. Overrides box.remoteDockerHost. Same as `--provider docker:<dest>`. remote-docker-only.',
  )
  .option(
    '--host-snapshot',
    'APFS-clone the host workspace into a per-box scratch dir before seeding /workspace (stabilizes the tar-pipe source)',
  )
  .option('--no-host-snapshot', 'bind the live workspace directly (host edits leak into reads)')
  .option(
    '--snapshot <ref>',
    'start from a project checkpoint (see `agentbox checkpoint`); overrides box.defaultCheckpoint',
  )
  .option('--image <ref>', 'override the box image', undefined)
  .option(
    '--build',
    'build the docker base image locally instead of pulling the prebuilt one from the registry',
  )
  .option('--attach', 'drop into a shell inside the box after it is ready')
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option(
    '--with-env',
    'copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at create time (gitignore-bypassing)',
  )
  .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
  .option(
    '--no-resync',
    "when starting from a checkpoint, do not merge the host's current branch + overlay its uncommitted/untracked changes (default: do, keeping the box's version on conflict)",
  )
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
  .option(
    '--disk <size>',
    'best-effort container writable-layer size (e.g. 10g); no-op on overlay2/macOS',
  )
  .option(
    '--size <spec>',
    'VM size for cloud providers. Hetzner: server type (e.g. cx33). DigitalOcean: Droplet size slug (e.g. s-4vcpu-8gb). Daytona: cpu-mem-disk GB (e.g. 4-8-20). Vercel: vCPUs (1, 2, 4, 8). E2B: baked at prepare time. Overrides box.size / box.size<Provider>.',
  )
  .option(
    '--location <name>',
    'Datacenter/region for the new box. Hetzner: nbg1, fsn1, hel1, ash (overrides box.hetznerLocation). DigitalOcean: nyc3, sfo3, ams3, fra1 (overrides box.digitaloceanRegion). Hetzner/DigitalOcean-only.',
  )
  .option(
    '--inbound <spec>',
    'Inbound-access policy for the VPS firewall. `locked` (default, host egress IP only), `open` (0.0.0.0/0, key-only — reach the box from a phone with the laptop off), or a CIDR list (e.g. 203.0.113.5/32). Overrides box.inbound. Hetzner/DigitalOcean-only.',
  )
  .option(
    '--bundle-depth <n>',
    'cap commits shipped in the cloud-seed git bundle (daytona, hetzner). 0 = full history. Unset = adaptive (200 commits, re-bundle at 100 if >20 MB). Ignored for docker.',
    (v) => {
      const n = Number.parseInt(v, 10);
      if (!Number.isInteger(n) || n < 0)
        throw new Error(`--bundle-depth: expected a non-negative integer, got "${v}"`);
      return n;
    },
  )
  .option(
    '--from-branch <ref>',
    "base the box's per-box branch on this ref (branch / tag / SHA) instead of HEAD. Branch/tag names are fetched from origin first.",
  )
  .option(
    '-b, --use-branch <name>',
    'reuse an existing branch directly instead of forking agentbox/<box-name>. Commits/pushes flow straight to it. Docker fails if the host already has it checked out. Mutually exclusive with --from-branch.',
  )
  .option('-y, --yes', 'skip prompts, accept defaults')
  .option(
    '--carry-yes',
    "auto-approve agentbox.yaml's `carry:` block (also AGENTBOX_CARRY_YES=1). Required for non-TTY use of `-y` when carry: is non-empty.",
  )
  .option(
    '--carry <mode>',
    "control the carry: block; 'skip' disables it for this box (also AGENTBOX_CARRY=skip). Default: 'ask' (prompt).",
    'ask',
  )
  .option(
    '--no-credential-sync',
    'disable automatic credential sync for this box (the in-box watcher that fans refreshed agent tokens out to your other boxes)',
  )
  .option(
    '--dangerously-with-credentials',
    "copy a git credential INTO the box so it can push with your PC off (needs no hub). You'll be asked at an interactive prompt to choose 'token' (push over HTTPS, commits unsigned, smallest exposure) or your 'ssh' private key (signs commits, riskiest). DANGEROUS: the credential lives in the box and its snapshots. Requires a real terminal (no non-interactive / CI path). Cloud providers only. Sets git.pushMode=direct.",
  )
  .option(
    '-v, --verbose',
    'also stream the raw provider output (docker build / Daytona snapshot create) to stderr. The same content always lands in ~/.agentbox/logs/create.log — pass -v when you want to watch it live without tailing the log.',
  )
  .option(
    '--via-hub',
    "enqueue the create on the control box (POST /remote/boxes) instead of building it on this machine; the resident hub worker provisions the box VPS-side. Cloud providers only. Needs a control plane configured (`control-plane set-url`) + admin token.",
  )
  .option('--url <url>', 'control-plane URL for --via-hub (default: relay.controlPlaneUrl)')
  .action(async (opts: CreateOptions) => {
    const cmdLog = openCommandLog('create');
    intro('Setting up a new box...');

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    // Register the project in the on-disk registry so the hub / web UI can list
    // it (even before it has any box). Best-effort: never block or fail create.
    // Other create entry points (agent commands, queue worker) are covered by
    // the hub's self-heal backfill, which registers any box's projectRoot it sees.
    try {
      await registerProject(projectRoot);
    } catch {
      /* best-effort project registration */
    }
    // `--provider` may be a host-qualified spec (`docker:buildbox`). Split it:
    // `providerName` must stay a bare name — it keys the per-provider config
    // (box.image<P>, box.defaultCheckpoint<P>) and lands on the box record.
    const { name: providerName, remoteHost: specRemoteHost } = parseProviderSpec(
      opts.provider ?? cfg.effective.box.provider ?? 'docker',
    );
    const remoteHost = opts.remoteHost ?? specRemoteHost;

    // --via-hub: hand the create to the control box's queue instead of building
    // it here. The resident hub worker clones the repo VPS-side and provisions
    // the box, so this returns once the job is enqueued/finished — no local
    // provider work. Cloud providers only (a docker box runs on THIS machine).
    if (opts.viaHub) {
      await runCreateViaHub(opts, providerName, projectRoot, cmdLog);
      return;
    }

    // `direct` push mode (box holds a copy of your git credentials) is only
    // meaningful for cloud boxes: a docker box runs on your host machine and
    // bind-mounts the host `.git`, so it is never independent of the host.
    if (cfg.effective.git.pushMode === 'direct' && providerName === 'docker') {
      log.error(
        'git.pushMode=direct / --dangerously-with-credentials is not applicable to docker boxes (they run on your host and bind-mount the host .git). Use a cloud provider (e.g. --provider hetzner|e2b|vercel|daytona).',
      );
      cmdLog.close();
      process.exit(1);
    }
    const checkpointRef = resolveCheckpointRef(
      opts,
      resolveDefaultCheckpoint(cfg.effective, providerName),
    );
    if (opts.location && providerName !== 'hetzner' && providerName !== 'digitalocean') {
      log.warn(
        `--location applies to hetzner/digitalocean only; ignored for provider ${providerName}`,
      );
    }
    if (opts.inbound && providerName !== 'hetzner' && providerName !== 'digitalocean') {
      log.warn(
        `--inbound applies to hetzner/digitalocean only; ignored for provider ${providerName}`,
      );
    }
    if (opts.remoteHost && providerName !== 'remote-docker') {
      log.warn(`--remote-host applies to remote-docker only; ignored for provider ${providerName}`);
    }
    // Box image: same precedence pattern as --size. `--image` wins; otherwise
    // the cascaded box.image / box.image<Provider> (written by `agentbox
    // prepare --provider X`).
    const imageDefault = resolveBoxImage(cfg.effective, providerName);
    const effectiveImage = opts.image && opts.image.length > 0 ? opts.image : imageDefault;

    // Cloud providers that use the Daytona public-URL path don't need
    // Portless; the URL is already reachable from anywhere. The wizard's
    // first-run `agentbox claude` hand-off is also Docker-only.
    const isDocker = providerName === 'docker';
    const isHetzner = providerName === 'hetzner';

    // Resolve Portless. Docker: classic prompt-once-then-persist flow.
    // Hetzner: default-on (per the "safe defaults for cloud providers"
    // policy) — silently set up the host proxy when undefined; respect
    // explicit --no-portless / config `portless.enabled: false`.
    let portlessEnabled: boolean | undefined;
    if (isDocker) {
      portlessEnabled = await maybePromptPortless({
        engine: await detectEngine(),
        enabled: cfg.effective.portless.enabled,
        yes: !!opts.yes,
        cwd: opts.workspace,
      });
    } else if (isHetzner) {
      portlessEnabled = cfg.effective.portless.enabled ?? true;
      // Only surface the :443 root-password dialog for interactive runs;
      // scripted / --yes Hetzner creates fall through to the no-root :1355 proxy.
      if (portlessEnabled)
        await setupPortlessHost({ allowRootPrompt: !!process.stdin.isTTY && !opts.yes });
    }

    // Carry gate (agentbox.yaml's `carry:` block): resolve + ask BEFORE the
    // wizard so the user sees the host-secrets prompt while still in the
    // pre-create phase. Cancel aborts; skip proceeds with no carry payload.
    let carryEntries: import('@agentbox/core').ResolvedCarryEntry[] = [];
    try {
      const gate = await runCarryGate({
        projectRoot,
        yes: !!opts.yes,
        // Pass undefined when the flag wasn't set so the env-var fallback in
        // runCarryGate (?? carryYesEnv / ?? carrySkipEnv) actually fires.
        carryYesFlag: opts.carryYes ? true : undefined,
        carrySkipFlag: opts.carry === 'skip' ? true : undefined,
        onLog: (line) => cmdLog.write(line),
      });
      if (gate.decision === 'cancel') {
        log.warn('carry: cancelled — not creating the box');
        cmdLog.close();
        process.exit(0);
      }
      if (gate.decision === 'approve') carryEntries = gate.entries;
    } catch (err) {
      log.error(err instanceof Error ? err.message : String(err));
      cmdLog.close();
      process.exit(1);
    }

    // git.pushMode=direct (--dangerously-with-credentials): copy the user's git credentials
    // into the box so it pushes/pulls/signs on its own (PC-off). Gated by its
    // own confirmation + security warning; the approved secret files ride the
    // same carry apply path as the carry: block above.
    carryEntries = await resolveGitCredsCarry({
      pushMode: cfg.effective.git.pushMode,
      projectRoot,
      existing: carryEntries,
      onLog: (line) => cmdLog.write(line),
      onClose: () => cmdLog.close(),
    });

    // First-run wizard: when no agentbox.yaml exists, optionally hand off to
    // `agentbox claude` so the agent can interactively generate one. The
    // wizard runs for every provider — it's the env-file picker + first-run
    // claude offer, both of which are useful for cloud boxes too.
    //
    // Base freshness: cloud providers store a fingerprint of the baked
    // runtime; if the local install no longer matches, the wizard offers to
    // rebuild before creating. Docker self-heals via `ensureImage`, so its
    // baseStatus is always `fresh` and the wizard is a no-op here.
    const baseStatus = await evaluateBaseFreshness(providerName, cfg.effective.box.claudeInstall);
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'create',
      checkpointRef,
      checkpointFromDefault: !(opts.snapshot && opts.snapshot.length > 0),
      provider: providerName,
      withEnv: cfg.effective.box.withEnv,
      baseStatus,
    });
    // Stale base: user opted in to rebuilding it. Re-bakes the snapshot /
    // template and refreshes its stored fingerprint, so the subsequent
    // create boots from the fresh base. Runs *before* checkpoint discard so
    // a failure aborts cleanly without leaving a half-created box.
    if (wiz.rebuildBase) {
      log.warn(`${providerName} base image is outdated; rebuilding before create…`);
      await runPrepare(providerName, {
        force: true,
        cwd: opts.workspace,
        suppressStatus: true,
      });
    }
    // Drop a stale/dead default checkpoint so the box provisions from the
    // current base. On the docker switch-to-claude re-dispatch below the
    // default isn't forwarded as `--snapshot`; the inner `agentbox claude`
    // re-evaluates a *missing/dead* default and discards it too. A *stale*
    // default that the user chose to RECREATE is forwarded explicitly via
    // WIZARD_RECREATE_ENV, because the inner non-interactive pass would
    // otherwise keep a stale checkpoint for a configured project.
    const effectiveCheckpointRef = wiz.discardCheckpoint ? undefined : checkpointRef;
    if (wiz.action === 'switch-to-claude' && isDocker) {
      // Docker: hand off to `agentbox claude` whose default action creates +
      // attaches in one go. For non-docker providers we fall through to the
      // normal create flow below and attach claude post-create, because
      // `agentbox claude`'s default action ignores --provider.
      process.env[WIZARD_AUTOLAUNCH_ENV] = '1';
      if (wiz.recreate) process.env[WIZARD_RECREATE_ENV] = '1';
      const serialized = serializeEnvFilesForEnv(wiz.envFilesToImport);
      if (serialized !== undefined) process.env[WIZARD_ENV_FILES_ENV] = serialized;
      try {
        await claudeCommand.parseAsync(passthroughFlags(opts), { from: 'user' });
      } finally {
        delete process.env[WIZARD_AUTOLAUNCH_ENV];
        delete process.env[WIZARD_RECREATE_ENV];
        delete process.env[WIZARD_ENV_FILES_ENV];
      }
      return;
    }
    // Cloud + switch-to-claude: provision the cloud box now, then attach
    // claude via the cloud SSH path once the box is ready.
    const attachClaudeAfter = wiz.action === 'switch-to-claude' && !isDocker;

    const useSnapshot = resolveUseSnapshot(opts, cfg.effective.box.hostSnapshot);

    // Verbose mode bypasses the spinner entirely: a cold cloud create
    // streams ~7 minutes of Dockerfile build output that's interesting to
    // watch and reassures the user that progress is happening. Without
    // --verbose, the spinner shows only the latest collapsed status line
    // (full output still lands in cmdLog) — calmer default.
    const s = makeProgressReporter(opts.verbose === true);
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
      let fromBranch: string | undefined;
      let useBranch: string | undefined;
      try {
        ({ fromBranch, useBranch } = await resolveBranchSelection({
          useBranch: opts.useBranch,
          fromBranch: opts.fromBranch,
          repo: opts.workspace,
          providerName: provider.name,
          cloudUseCurrentBranch: cfg.effective.cloud.useCurrentBranch,
          log: (m) => {
            s.message(m);
            cmdLog.write(m);
          },
        }));
      } catch (err) {
        if (err instanceof FromBranchError || err instanceof UseBranchError) {
          s.stop('aborting: invalid branch selection');
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
      const result = await provider.create({
        workspacePath: opts.workspace,
        name: opts.name,
        checkpointRef: effectiveCheckpointRef,
        image: effectiveImage,
        allowPull: opts.build ? false : undefined,
        imageRegistry: cfg.effective.box.imageRegistry,
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        envFilesToImport: wiz.envFilesToImport,
        carry: carryEntries,
        vnc: { enabled: cfg.effective.box.vnc },
        credentialSync: cfg.effective.box.credentialSync,
        limits: resolveLimits(cfg.effective.box, opts),
        bundleDepth: cfg.effective.box.bundleDepth,
        fromBranch,
        useBranch,
        resyncOnStart: opts.resync,
        // When a control plane is configured, a cloud box's live relay IS the
        // plane: the provider resolves control-plane topology, registers the box
        // on the plane, and the box forwards /rpc + leases push tokens directly.
        // Cloud-only in effect; the docker provider ignores it.
        controlPlaneUrl: cfg.effective.relay.controlPlaneUrl,
        gitPushMode: cfg.effective.git.pushMode,
        projectRoot,
        onLog: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
        providerOptions: {
          useSnapshot,
          sharedCache: cfg.effective.box.dockerCacheShared,
          portless: portlessEnabled,
          portlessStateDir: cfg.effective.portless.stateDir || undefined,
          // Size / location / session-lifetime overrides, resolved from the
          // flags then the cascaded config. The cloud scaffold reads them;
          // providers ignore the keys they don't know.
          ...cloudSizingProviderOptions(provider.name, cfg.effective, {
            size: opts.size,
            location: opts.location,
            inbound: opts.inbound,
            remoteHost,
          }),
        },
      });
      s.stop(`box ${result.record.container} ready`);
      const createResyncWarning = result.resync ? buildResyncWarning(result.resync) : null;
      if (createResyncWarning) log.warn(createResyncWarning);

      // Default-on: write the `~/.agentbox/ssh/config` entry for SSH-capable
      // cloud boxes (Hetzner/DigitalOcean) so `ssh <box>` just works. Best-effort
      // and gated by `ssh.autoConfig`; skips docker and token-auth providers.
      if (!isDocker) {
        await autoWriteSshConfig(result.record, provider, cfg.effective.ssh.autoConfig, (m) =>
          log.warn(m),
        );
      }

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
            `  agentbox attach ${result.record.name}`,
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
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
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
      cmdLog.close();
      process.exit(1);
    } finally {
      cmdLog.close();
    }
  });
