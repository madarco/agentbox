import { intro, log, outro } from '@clack/prompts';
import {
  bumpProjectGcCounter,
  findProjectRoot,
  hashProjectPath,
  loadEffectiveConfig,
  pruneOrphanProjectConfigs,
  registerProject,
  resolveBoxImage,
  resolveDefaultCheckpoint,
  type UserConfig,
} from '@agentbox/config';
import { persistentRefusal } from '@agentbox/core';
import { detectEngine, listBoxes, type BoxRecord } from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { runCarryGate, runQueuedCarryGate } from '../lib/carry-gate.js';
import { runToolsGate } from '../lib/tools-gate.js';
import { directGitModeRefusal, resolveGitCredsCarry } from '../lib/git-creds-gate.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../lib/from-branch.js';
import { openCommandLog } from '@agentbox/cli-kit';
import { makeProgressReporter } from '@agentbox/cli-kit';
import { maybePromptPortless, setupPortlessHost } from '../portless-prompt.js';
import { providerSpecFor, resolveProviderChoice } from '../provider/spec.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import {
  maybeRunSetupWizard,
  passthroughFlags,
  serializeEnvFilesForEnv,
  WIZARD_AUTOLAUNCH_ENV,
  WIZARD_ENV_FILES_ENV,
  WIZARD_RECREATE_ENV,
} from '../wizard.js';
import { evaluateBaseFreshness, warnCheckpointAgentMismatch } from '../checkpoint-lookup.js';
import { runPrepare } from './prepare.js';
import { agentCommandEntry } from '../agents/commands.js';
import { syncAgentCredentialsIfChanged } from './control-plane.js';
import {
  resolveCreateTarget,
  pushCreateSeed,
  type CreateTarget,
} from '../control-plane/create-target.js';
import { streamJobToCompletion } from '../control-plane/job-stream.js';
import { withHubClient } from '../control-plane/with-hub.js';
import { dockerProviderRefusal, remoteHubConfigured } from '../control-plane/remote-hub.js';
import { attachRelayOptions } from '../control-plane/box-plane.js';
import { resolveBoxOrExit } from '../box-ref.js';

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
  /** --persistent / --no-persistent: always-on box (config box.persistent). */
  persistent?: boolean;
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
  /** --via-hub: force enqueue the create on the control box instead of building locally. */
  viaHub?: boolean;
  /** --local: force a local build even when a control box would take a cloud create by default. */
  local?: boolean;
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
  if (opts.persistent !== undefined) box.persistent = opts.persistent;
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
    ...(await attachRelayOptions(record)),
    boxId: record.id,
    boxName: record.name,
    projectIndex: record.projectIndex,
    mode: 'shell',
  });
  process.exit(code);
}

/**
 * Remote (control-box) create: push the project seed first so `.env`/untracked
 * files a fresh clone can't provide reach the box, then `POST /api/v1/boxes` with
 * the origin URL and stream the job to completion. Never touches a local provider.
 * Exits with the job's outcome (0 on done, 1 on failure), like the local path.
 *
 * `agentbox create` builds a plain box (no agent) — the agent-launcher via-hub
 * path (`_cloud-agent-via-hub.ts`) is what starts an agent.
 */
async function runCreateViaHubApi(
  target: Extract<CreateTarget, { where: 'remote' }>,
  opts: CreateOptions,
  providerName: string,
  /**
   * remote-docker only: the engine alias. The control box keys its own host
   * registry by alias, so the request must name `docker:<alias>` — a bare
   * `remote-docker` would name no engine at all.
   */
  remoteHost: string | undefined,
  projectRoot: string,
  cmdLog: ReturnType<typeof openCommandLog>,
): Promise<void> {
  // A stale login on the control box means the box comes up signed out — refresh
  // custody from the host backup first (hash-compared, silent + best-effort).
  await syncAgentCredentialsIfChanged(opts.url);
  // Always push seed material first (hash-skipped so an unchanged tree costs
  // nothing). This is the fix for hub-routed creates coming up missing .env /
  // untracked files — the clone-side worker overlays what we push to custody.
  // Resolve + approve `carry:` here rather than on the local path below: this
  // branch returns before that gate ever runs, so without this a hub-routed
  // create silently ignores the block. Carry is the only route by which a
  // GITIGNORED file reaches a box — the untracked seed excludes ignored paths by
  // design — so dropping it is not a cosmetic gap.
  const carryForHub = await runQueuedCarryGate({
    projectRoot,
    opts,
    onLog: (line) => cmdLog.write(line),
    onClose: () => cmdLog.close(),
  });
  await pushCreateSeed({
    custody: target.custody,
    repoUrl: target.repoUrl,
    projectRoot,
    ...(carryForHub.length > 0 ? { carry: carryForHub } : {}),
    onLog: (line) => cmdLog.write(line),
  });

  // Cloud-relevant box-shaping flags the user passed. The control box applies the
  // direct `provider.create` args (snapshot/image/env/vnc/bundle-depth/build/
  // credential-sync) and falls back to its own config for the rest (VM sizing) —
  // consistent with `prepare`. `carry:` does NOT ride here: its payloads are
  // files, not flags, so they travel with the seed above. Docker-only knobs
  // (portless/limits) are inapplicable to a control-box clone build.
  const remoteOpts = {
    ...(opts.snapshot ? { snapshot: opts.snapshot } : {}),
    ...(opts.image ? { image: opts.image } : {}),
    ...(opts.withPlaywright === true ? { withPlaywright: true } : {}),
    ...(opts.withEnv === true ? { withEnv: true } : {}),
    ...(opts.vnc === false ? { vnc: false } : {}),
    ...(opts.persistent !== undefined ? { persistent: opts.persistent } : {}),
    ...(opts.bundleDepth !== undefined ? { bundleDepth: opts.bundleDepth } : {}),
    ...(opts.build === true ? { build: true } : {}),
    ...(opts.credentialSync === false ? { credentialSync: false } : {}),
  };
  const outcome = await withHubClient({ url: opts.url }, async (client) => {
    const { jobId } = await client.createBox({
      repoUrl: target.repoUrl,
      provider: providerSpecFor(providerName, remoteHost),
      agent: 'none',
      name: opts.name?.trim() || undefined,
      fromBranch: opts.fromBranch?.trim() || undefined,
      ...(Object.keys(remoteOpts).length > 0 ? { opts: remoteOpts } : {}),
    });
    cmdLog.write(`enqueued on the control box: job ${jobId}`);
    return await streamJobToCompletion(client, jobId, {
      onLine: (line) => {
        cmdLog.write(line);
        if (opts.verbose) process.stderr.write(line + '\n');
      },
      onStatus: (s) => process.stderr.write(`control box: ${s}\n`),
    });
  });

  // withHubClient reported an unreachable/unsupported hub (or a HubApiError from
  // createBox) and set process.exitCode; nothing more to say.
  if (!outcome) {
    cmdLog.close();
    process.exit(process.exitCode || 1);
  }
  if (outcome.status !== 'done') {
    log.error(`create failed: ${outcome.detail ?? outcome.job?.error ?? outcome.status}`);
    cmdLog.close();
    process.exit(1);
  }
  outro(`box ready: ${outcome.job?.boxId ?? '(id pending)'}`);
  cmdLog.close();
  process.exit(0);
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
    '--persistent',
    'always-on box: never auto-paused, never idle-lapsed, skipped by `agentbox prune`, confirmed before destroy, and started again by the relay after a host reboot. Not available on e2b/vercel (platform session cap). Sets box.persistent for this box.',
  )
  .option('--no-persistent', 'create an expendable box even when box.persistent is set')
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
    'force enqueuing the create on the control box instead of building it on this machine; the resident hub worker provisions the box VPS-side. Cloud providers only. Needs a control plane configured (`hub set-url`) + admin token. When a control box is configured this is already the default for cloud boxes (cloud.viaHub).',
  )
  .option(
    '--local',
    'force building the box on this machine even when a control box is configured (the opposite of --via-hub; cloud.viaHub=false makes this the default). Docker boxes are always local.',
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
    // `providerName` stays a bare name — it keys the per-provider config
    // (box.image<P>, box.defaultCheckpoint<P>) and lands on the box record; the
    // engine rides alongside it in `remoteHost`.
    const { providerName, remoteHost } = resolveProviderChoice(cfg.effective, {
      provider: opts.provider,
      remoteHost: opts.remoteHost,
    });

    // Docker off under a remote hub (Step 12): with a control box configured a
    // docker box built here can't run with the laptop off, so it's refused unless
    // hub.mode=local. Runs BEFORE routing so a control-box create can't slip past.
    const dockerRefusal = await dockerProviderRefusal(
      cfg.effective,
      providerName,
      remoteHost,
      'create',
    );
    if (dockerRefusal) {
      log.error(dockerRefusal);
      cmdLog.close();
      process.exit(1);
    }

    // Always-on box on a provider whose platform session cap the host can only
    // extend, never remove. Runs BEFORE routing so a control-box create cannot
    // slip past it.
    if (cfg.effective.box.persistent) {
      const refusal = persistentRefusal(providerName);
      if (refusal) {
        log.error(refusal);
        cmdLog.close();
        process.exit(1);
      }
    }

    // git.pushMode=direct (--dangerously-with-credentials) gating, in the same
    // order every other entry point uses (agent launchers + connect): check the
    // PROVIDER first — docker can't do direct, it bind-mounts the host .git — then
    // refuse under a control box, where token leasing already gives the box
    // laptop-off push without copying a credential into it. Both run BEFORE routing
    // so a control-box create can't slip into the hub path first.
    if (cfg.effective.git.pushMode === 'direct') {
      if (providerName === 'docker') {
        log.error(
          'git.pushMode=direct / --dangerously-with-credentials is not applicable to docker boxes (they run on your host and bind-mount the host .git). Use a cloud provider (e.g. --provider hetzner|e2b|vercel|daytona).',
        );
        cmdLog.close();
        process.exit(1);
      }
      const refusal = directGitModeRefusal({
        pushMode: cfg.effective.git.pushMode,
        hubInPlay: remoteHubConfigured(cfg.effective) || Boolean(opts.viaHub),
      });
      if (refusal) {
        log.error(refusal);
        cmdLog.close();
        process.exit(1);
      }
    }

    // Pick WHICH HUB the create goes to (both modes go through POST /api/v1/boxes;
    // only the target + request shape differ). Remote (a control box clones the
    // repo VPS-side) → push seed + repoUrl. Local/co-located (build from the local
    // workspace) → projectId, file queue. docker / remote-docker / --local /
    // cloud.viaHub=false stay local; --via-hub forces remote (hard-fail on a
    // missing prereq); the DEFAULT path falls back to local with a notice.
    const target = await resolveCreateTarget({
      providerName,
      remoteHost,
      effective: cfg.effective,
      projectRoot,
      forceHub: opts.viaHub,
      forceLocal: opts.local,
      urlFlag: opts.url,
    });
    if (target.where === 'error') {
      log.error(target.message);
      cmdLog.close();
      process.exit(1);
    }
    if (target.where === 'remote') {
      await runCreateViaHubApi(target, opts, providerName, remoteHost, projectRoot, cmdLog);
      return;
    }
    if (target.fellBackReason) {
      log.warn(
        `control box configured but ${target.fellBackReason}; building ${providerName} box locally.`,
      );
    }

    const checkpointRef = resolveCheckpointRef(
      opts,
      resolveDefaultCheckpoint(cfg.effective, providerName),
    );
    // A bare `create` has no agent set, so this is silent unless the caller
    // asked for one — "unknown" is never a mismatch.
    await warnCheckpointAgentMismatch(
      providerName,
      projectRoot,
      checkpointRef,
      undefined,
      (m: string) => log.warn(m),
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

    // Host-tool gate (agentbox.yaml's `tools:` block): a committed yaml can
    // only REQUEST host CLIs; the grant is the host's decision and lands in
    // the host-only grant file. Never blocks creation — a declined request
    // just means the box doesn't get that command.
    try {
      await runToolsGate({
        projectRoot,
        yes: !!opts.yes,
        onLog: (line) => cmdLog.write(line),
      });
    } catch (err) {
      log.warn(`tools: ${err instanceof Error ? err.message : String(err)}`);
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
    const baseStatus = await evaluateBaseFreshness(providerName);
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
        const claude = agentCommandEntry('claude');
        if (!claude) throw new Error('create: no claude command registered');
        await claude.command.parseAsync(passthroughFlags(opts), { from: 'user' });
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

    // Branch selection is validated against the LOCAL host repo — correct here,
    // because a local build reads from this machine's checkout. (The remote path
    // returned above without validating, since the PC may hold no copy of the
    // repo; the backend validates the ref there.)
    let fromBranch: string | undefined;
    let useBranch: string | undefined;
    try {
      ({ fromBranch, useBranch } = await resolveBranchSelection({
        useBranch: opts.useBranch,
        fromBranch: opts.fromBranch,
        repo: opts.workspace,
        providerName,
        cloudUseCurrentBranch: cfg.effective.cloud.useCurrentBranch,
        log: (m) => cmdLog.write(m),
      }));
    } catch (err) {
      if (err instanceof FromBranchError || err instanceof UseBranchError) {
        log.error(err.message);
        cmdLog.close();
        process.exit(2);
      }
      throw err;
    }

    // Verbose mode streams the worker's raw build output; the default collapses to
    // a single self-updating status line (full output still lands in cmdLog). Both
    // stream live, so a detached create never looks hung.
    const s = makeProgressReporter(opts.verbose === true);
    s.start('creating box');
    // `agentbox create` builds a PLAIN box (no agent). The worker seeds the box
    // from the local workspace tree, so untracked/.env arrive as they always did.
    const outcome = await withHubClient({ preferLocal: true }, async (client) => {
      const { jobId } = await client.createBox({
        projectId: hashProjectPath(projectRoot),
        provider: opts.provider ?? providerName,
        agent: 'none',
        name: opts.name?.trim() || undefined,
        // Interactive create — the scheduler runs it in the ungated foreground
        // lane, so it never queues behind background `-i` jobs.
        foreground: true,
        fromBranch,
        opts: {
          image: effectiveImage,
          snapshot: effectiveCheckpointRef,
          hostSnapshot: useSnapshot,
          withPlaywright: opts.withPlaywright,
          withEnv: cfg.effective.box.withEnv,
          envFiles: wiz.envFilesToImport,
          vnc: cfg.effective.box.vnc,
          persistent: cfg.effective.box.persistent,
          resync: opts.resync,
          sharedDockerCache: cfg.effective.box.dockerCacheShared,
          portless: portlessEnabled,
          memory: opts.memory,
          cpus: opts.cpus,
          pidsLimit: opts.pidsLimit,
          disk: opts.disk,
          bundleDepth: cfg.effective.box.bundleDepth,
          size: opts.size,
          location: opts.location,
          inbound: opts.inbound,
          useBranch,
          build: opts.build,
          credentialSync: cfg.effective.box.credentialSync,
          imageRegistry: cfg.effective.box.imageRegistry,
          gitPushMode: cfg.effective.git.pushMode,
          remoteHost,
          // carry rides to the worker on THIS machine (same host), which reads the
          // approved host files at box-create time.
          carry: carryEntries,
        },
      });
      cmdLog.write(`enqueued: job ${jobId}`);
      return await streamJobToCompletion(client, jobId, {
        onLine: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
        onStatus: (st) => s.message(`box create: ${st}`),
      });
    });

    if (!outcome) {
      // withHubClient reported an unreachable/unsupported hub and set exitCode.
      s.stop('failed');
      cmdLog.close();
      process.exit(process.exitCode || 1);
    }
    if (outcome.status !== 'done') {
      s.stop('failed');
      log.error(`create failed: ${outcome.detail ?? outcome.job?.error ?? outcome.status}`);
      cmdLog.close();
      process.exit(1);
    }

    // Resolve the box the worker just registered (same machine → local state) so
    // we can print its handles and, if asked, attach. Best-effort — the box is up
    // regardless of whether we can render its record.
    const boxId = outcome.job?.boxId;
    const record = boxId
      ? await resolveBoxOrExit(boxId).catch(() => null)
      : opts.name
        ? await resolveBoxOrExit(opts.name).catch(() => null)
        : null;
    s.stop(record ? `box ${record.container} ready` : 'box ready');

    if (record) {
      log.info(`id:        ${record.id}`);
      if (typeof record.projectIndex === 'number') {
        log.info(`n:         ${String(record.projectIndex)}   (in ${projectRoot})`);
      }
      if (isDocker) log.info(`container: ${record.container}`);
      log.info(`image:     ${record.image}`);
      const tryLines = isDocker
        ? [
            `  docker exec -it ${record.container} bash`,
            `  docker exec ${record.container} ls /workspace`,
          ]
        : [
            `  agentbox shell ${record.name}`,
            `  agentbox attach ${record.name}`,
            `  agentbox url ${record.name}`,
          ];
      log.message(
        ['', 'Try it:', ...tryLines, '', 'Destroy:', `  agentbox destroy ${record.name}`].join(
          '\n',
        ),
      );
    }

    // Periodic best-effort housekeeping: every Nth create, reap per-project config
    // dirs whose source workspace folder was deleted. Must never fail create.
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

    // Provider decisions that changed what the user got (a daytona linux-vm bake
    // that could only produce a container, say). They streamed past inside the
    // progress reporter, which overwrites itself, so re-state them here where
    // they stay on screen — this is the last moment before the box is handed
    // over or attached to.
    for (const w of cmdLog.warnings()) log.warn(w);

    outro('done');

    // Cloud + switch-to-claude: attach claude over SSH now the box is provisioned.
    // Docker takes the redispatch-to-`agentbox claude` path above (which attaches).
    if (attachClaudeAfter && record) {
      const { cloudAgentAttach } = await import('./_cloud-attach.js');
      await cloudAgentAttach({
        box: record,
        binary: 'claude',
        sessionName: 'claude',
        mode: 'claude',
      });
      cmdLog.close();
      return;
    }
    if (opts.attach && record) {
      cmdLog.close();
      await attachShell(record);
    }
    cmdLog.close();
  });
