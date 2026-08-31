/**
 * The shared body of `agentbox <agent>` — create a box and launch the agent.
 *
 * One copy of what used to be three: the queue/`-i` path, the carry and tools
 * gates, git-credential carry, branch selection, the hub route, the cloud
 * delegate and the docker create+attach. Everything genuinely per-agent reaches
 * this through {@link AgentCliSpec} — its runtime bindings for the docker calls,
 * and at most five hooks for the code an agent runs itself.
 */
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveBoxImage,
  resolveDefaultCheckpoint,
  type UserConfig,
} from '@agentbox/config';
import type { ResolvedCarryEntry } from '@agentbox/core';
import {
  createBox,
  DEFAULT_BOX_IMAGE,
  detectEngine,
  recordLastAgent,
} from '@agentbox/sandbox-docker';
import { intro, log, outro } from '@agentbox/cli-kit';
import { reattachRef } from '../../box-ref.js';
import { warnCheckpointAgentMismatch } from '../../checkpoint-lookup.js';
import { assertAgentCredsAvailable, MissingAgentCredsError } from '../../lib/queue/assert-creds.js';
import { buildPromptArgs } from '../../lib/queue/build-prompt-args.js';
import { cloudSizingProviderOptions } from '../../lib/cloud-sizing.js';
import { parseMaxOption } from '../../lib/queue/parse-max-option.js';
import { submitQueueJob } from '../../lib/queue/submit.js';
import { captureOpenTerminalContext } from '../../terminal/queue-open.js';
import { hostAwareOpenIn } from '../../terminal/host.js';
import { buildResyncWarning } from '../../lib/resync-warning.js';
import { resolveAttachInOption } from '../../commands/_attach-in.js';
import { cloudAgentAttach } from '../../commands/_cloud-attach.js';
import { cloudAgentCreate } from '../../commands/_cloud-agent-create.js';
import {
  createCloudBoxViaHubAndAdopt,
  enqueueAgentJobViaHub,
  withHubJobLine,
} from '../../commands/_cloud-agent-via-hub.js';
import { ensureProjectRepoOnControlPlane } from '../../control-plane/ensure-repo-installed.js';
import { resolveCreateRouting, type CreateRouting } from '../../control-plane/route-create.js';
import { dockerProviderRefusal, remoteHubConfigured } from '../../control-plane/remote-hub.js';
import { runCarryGate, runQueuedCarryGate } from '../../lib/carry-gate.js';
import { runToolsGate } from '../../lib/tools-gate.js';
import { directGitModeRefusal, resolveGitCredsCarry } from '../../lib/git-creds-gate.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../../lib/from-branch.js';
import { providerForBox, providerForCreate } from '../../provider/registry.js';
import { resolveProviderChoice } from '../../provider/spec.js';
import {
  prepareTeleport,
  TeleportError,
  uploadTeleport,
  type ResumeMode,
} from '../../session-teleport/index.js';
import { clampSpinnerLine } from '@agentbox/cli-kit';
import { makeProgressReporter } from '@agentbox/cli-kit';
import { printLaunchRecap } from '../../lib/launch-recap.js';
import { openCommandLog } from '@agentbox/cli-kit';
import { resolveLimits } from '../../limits.js';
import { maybePromptPortless } from '../../portless-prompt.js';
import { handleLifecycleError } from '../../commands/_errors.js';
import { isolateOptionKey, type AgentCreateOptions } from './options.js';
import { RESUME_SEED } from './types.js';
import type { AgentCliSpec, AgentCreateContext, AgentPreflight } from './types.js';

/** Config overrides the create flags produce; the per-agent keys are delegated. */
function buildCliOverrides(a: AgentCliSpec, opts: AgentCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  // `<agent>.sessionName`, `<agent>.dangerouslySkipPermissions` and
  // `box.isolate<Agent>Config` — typed accessors, since config is a leaf that
  // cannot generate per-agent keys from the registry.
  const out: Partial<UserConfig> = a.runtime.cliOverrides({
    sessionName: opts.sessionName,
    skipPermissions: opts.dangerouslySkipPermissions,
    isolate: opts[isolateOptionKey(a.id)] === true ? true : undefined,
  });
  const mergedBox = { ...box, ...(out.box ?? {}) };
  if (Object.keys(mergedBox).length > 0) out.box = mergedBox;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  if (opts.dangerouslyWithCredentials) out.git = { pushMode: 'direct' };
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
  return out;
}

/** The subset of the create flags the background-queue worker replays. */
function pickQueueCreateOpts(
  a: AgentCliSpec,
  opts: AgentCreateOptions,
): import('@agentbox/relay').QueueJobCreateOpts {
  return {
    workspace: opts.workspace,
    name: opts.name,
    hostSnapshot: opts.hostSnapshot,
    snapshot: opts.snapshot,
    image: opts.image,
    withPlaywright: opts.withPlaywright,
    withEnv: opts.withEnv,
    vnc: opts.vnc,
    resync: opts.resync,
    sharedDockerCache: opts.sharedDockerCache,
    portless: opts.portless,
    sessionName: opts.sessionName,
    ...(a.runtime.skipPermissions
      ? { dangerouslySkipPermissions: opts.dangerouslySkipPermissions }
      : {}),
    memory: opts.memory,
    cpus: opts.cpus,
    pidsLimit: opts.pidsLimit,
    disk: opts.disk,
  };
}

/**
 * `-c` / `--resume`: teleport a host session into the new box.
 *
 * Shared, not per-agent, and that is load-bearing. When this lived in each
 * agent's own preflight hook, opencode — which has no teleport and therefore no
 * hook — silently IGNORED `-c` and went on to build a box, instead of refusing
 * the way it always had. `prepareTeleport` already refuses on
 * `caps.teleport: 'stub'` with the reason the registry row carries, so routing
 * every agent through here is both the fix and the reason no agent needs a hook
 * for the common case.
 */
export async function resolveResumeSeed(
  a: AgentCliSpec,
  ctx: AgentCreateContext,
  opts: AgentCreateOptions,
): Promise<AgentPreflight> {
  const wantsResume = opts.continue === true || Boolean(opts.resume);
  if (!wantsResume) return { seeds: [] };

  // An agent without teleport is refused first, before the flag-combination
  // checks below: "not supported for this agent" is the useful answer, and
  // telling someone their two unsupported flags conflict is not.
  const stub = a.spec.caps.teleport === 'stub';
  let mode: ResumeMode;
  if (stub) {
    mode = { kind: 'continue' };
  } else {
    if (opts.continue === true && opts.resume) {
      ctx.fail('only one of -c / --continue / --resume can be passed');
    }
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      ctx.fail(a.text.resumeWithPromptError);
    }
    mode = opts.continue === true ? { kind: 'continue' } : { kind: 'resume', id: opts.resume! };
  }

  try {
    const resolved = await prepareTeleport({
      agent: a.id,
      hostCwd: ctx.workspace,
      mode,
      log: ctx.writeLog,
    });
    return {
      seeds: [
        {
          label: `uploading ${a.id} session into box`,
          tag: RESUME_SEED,
          resolved,
          forwardArgs: resolved.forwardArgs,
          ownsFirstTurn: true,
        },
      ],
      hubIncompatible: true,
    };
  } catch (err) {
    if (err instanceof TeleportError) ctx.fail(err.message);
    throw err;
  }
}

export async function runAgentCreate(
  a: AgentCliSpec,
  agentArgs: string[],
  opts: AgentCreateOptions,
): Promise<void> {
  const cmdLog = openCommandLog(a.id);
  intro(`Starting ${a.shortName} in a box...`);

  const fail = (message: string, code = 2): never => {
    log.error(message);
    cmdLog.close();
    process.exit(code);
  };

  const cfgLoaded = await loadEffectiveConfig(opts.workspace, {
    cliOverrides: buildCliOverrides(a, opts),
  });
  const cfg = cfgLoaded.effective;
  const projectRoot = (await findProjectRoot(opts.workspace)).root;
  // Resolve provider. The cloud path skips docker-only steps (login offer,
  // Portless, createBox) and delegates to cloudAgentCreate.
  const { providerName, remoteHost } = resolveProviderChoice(cfg, { provider: opts.provider });
  const isCloud = providerName !== 'docker';

  /**
   * Memoised: claude's setup wizard needs the routing decision BEFORE it can
   * decide whether this machine's stale base even matters, while codex and
   * opencode only ask inside the cloud branch. Resolving lazily keeps both — a
   * docker run that never asks still never pays the control-box round trip.
   */
  let routingPromise: Promise<CreateRouting> | undefined;
  const routing = (): Promise<CreateRouting> =>
    (routingPromise ??= resolveCreateRouting({
      providerName,
      remoteHost,
      effective: cfg,
      projectRoot,
      forceHub: opts.viaHub,
      forceLocal: opts.local,
      urlFlag: opts.url,
    }));

  const ctx: AgentCreateContext = {
    opts: opts as unknown as Record<string, unknown>,
    workspace: opts.workspace,
    cfg,
    projectRoot,
    providerName,
    writeLog: (line) => cmdLog.write(line),
    fail,
    routing,
  };

  // Host state resolved BEFORE any box work, so a missing session id or a bad
  // --plan path fails fast and the user doesn't pay for a doomed box.
  const base = await resolveResumeSeed(a, ctx, opts);
  const preflight: AgentPreflight = a.hooks?.preflight ? await a.hooks.preflight(ctx, base) : base;

  // Docker off under a remote hub (Step 12): a docker box built here can't run
  // with the laptop off, so it's refused under a control box unless hub.mode=local.
  const dockerRefusal = await dockerProviderRefusal(cfg, providerName, remoteHost, 'create');
  if (dockerRefusal) fail(dockerRefusal, 1);

  if (cfg.git.pushMode === 'direct' && !isCloud) {
    fail(
      'git.pushMode=direct / --dangerously-with-credentials is not applicable to docker boxes (they run on your host and bind-mount the host .git). Use a cloud provider (e.g. --provider hetzner|e2b|vercel|daytona).',
      1,
    );
  }

  // Refuse copying a git credential into the box when a control box is in play —
  // token leasing does the same laptop-off push without the copy. Checked before
  // routing / the -i path so it can't slip into the hub create.
  const directRefusal = directGitModeRefusal({
    pushMode: cfg.git.pushMode,
    hubInPlay: remoteHubConfigured(cfg) || Boolean(opts.viaHub),
  });
  if (directRefusal) fail(directRefusal, 1);

  // When a control plane is configured, make sure this project's repo is
  // authorized on its GitHub App so the box can lease push tokens.
  await ensureProjectRepoOnControlPlane({
    controlPlaneUrl: cfg.relay.controlPlaneUrl,
    gitPushMode: cfg.git.pushMode,
    hubGitAuth: cfg.hub.gitAuth,
    projectRoot,
    yes: !!opts.yes,
  });

  const providerDefault = resolveDefaultCheckpoint(cfg, providerName);
  const checkpointRef =
    opts.snapshot && opts.snapshot.length > 0
      ? opts.snapshot
      : providerDefault.length > 0
        ? providerDefault
        : undefined;
  // A `box.defaultCheckpoint<Provider>` captured from another agent's box
  // applies here with no user signal at all — say so. Advisory: it still boots.
  await warnCheckpointAgentMismatch(providerName, projectRoot, checkpointRef, [a.id], (m: string) =>
    log.warn(m),
  );

  const applySkip = (args: string[]): string[] =>
    a.runtime.skipPermissions ? a.runtime.skipPermissions.apply(args, cfg) : args;

  if (opts.initialPrompt && opts.initialPrompt.length > 0) {
    // Captured as a const so the narrowing survives into the status-line
    // callback below (TS drops property narrowing inside a closure).
    const seedPrompt = opts.initialPrompt;
    // --dangerously-with-credentials is foreground-only (the queue worker doesn't
    // thread git.pushMode=direct, and copying a credential needs a human).
    if (cfg.git.pushMode === 'direct') {
      fail(
        '--dangerously-with-credentials is not supported with -i / background runs — run it in the foreground so you can confirm the credential copy interactively.',
        1,
      );
    }
    // Route the background run to the control box when configured — the worker
    // creates the box AND starts the agent with the prompt (laptop off). Local
    // creds aren't needed for the hub path (custody seeds them).
    const iRouting = await routing();
    if (iRouting.where === 'hub') {
      // Resolve + approve `carry:` BEFORE enqueuing: the hub worker builds the
      // box from a clone plus custody, so anything the user wants copied has to
      // ride the seed. Skipping this is how an approved file silently failed to
      // reach a hub-created box.
      const carryForHub = await runQueuedCarryGate({
        projectRoot,
        opts,
        onLog: (line) => cmdLog.write(line),
        onClose: () => cmdLog.close(),
      });
      const res = await withHubJobLine(
        (onStatus) =>
          enqueueAgentJobViaHub({
            providerName,
            remoteHost,
            projectRoot,
            agent: a.id,
            carry: carryForHub,
            name: opts.name,
            fromBranch: opts.fromBranch,
            urlFlag: opts.url,
            prompt: seedPrompt,
            agentArgs: applySkip(agentArgs),
            onStatus,
            onLog: (line) => cmdLog.write(line),
          }),
        (r) => (r ? 'run started on the remote hub' : 'remote hub unavailable'),
        { verbose: opts.verbose === true },
      );
      if (res) {
        if (res.error) {
          fail(
            `control plane run failed: ${res.error}` +
              (res.boxId
                ? ` (box ${res.boxId} was created — attach with \`agentbox ${a.id} attach ${res.boxId}\`)`
                : ''),
            1,
          );
        }
        outro(`${a.id} is running on the control plane: box ${res.boxId ?? '(id pending)'}`);
        cmdLog.close();
        return;
      }
    }
    if (iRouting.where === 'local' && iRouting.fellBackReason) {
      log.warn(
        `control box configured but ${iRouting.fellBackReason}; running this -i job locally.`,
      );
    }
    try {
      await assertAgentCredsAvailable({
        agent: a.spec.wireId ?? a.id,
        image: cfg.box.image,
        providerName,
        // The agent's own check, not a chain in the shared helper.
        hostCredStatus: (o) => a.runtime.hostCredStatus(o),
      });
    } catch (err) {
      if (err instanceof MissingAgentCredsError) fail(err.message);
      throw err;
    }
    const maxRunningOverride = parseMaxOption('--max-running', opts.maxRunning);
    const maxWorkingOverride = parseMaxOption('--max-working', opts.maxWorking);
    // Carry gate runs here on the host (same gate as the foreground path); the
    // approved entries ride the queue job and the worker applies them.
    const carryForQueue = await runQueuedCarryGate({
      projectRoot,
      opts,
      onLog: (line) => cmdLog.write(line),
      onClose: () => cmdLog.close(),
    });
    const result = await submitQueueJob({
      agent: a.spec.wireId ?? a.id,
      boxName: opts.name ?? '',
      providerName,
      prompt: opts.initialPrompt,
      agentArgs,
      createOpts: { ...pickQueueCreateOpts(a, opts), carry: carryForQueue },
      maxRunningOverride,
      maxWorkingOverride,
      openTerminal: captureOpenTerminalContext(cfg.queue.openIn),
    });
    outro(
      `job ${result.job.id} queued (${String(result.runningCount)}/${String(result.maxConcurrent)} running); log: ${result.job.logPath}`,
    );
    cmdLog.close();
    return;
  }

  /**
   * The first-run sign-in offer and the Portless opt-in, which two agents place
   * differently and both for a reason.
   *
   * claude asks BEFORE the gates, so the user has signed in before its setup
   * wizard can spend minutes re-baking a stale base. codex and opencode ask just
   * before the box is built, which on the cloud path is AFTER the hub-routing
   * decision — so a box the control box is going to build never prompts for a
   * local login it will not use. Unifying either way would lose one of those.
   */
  let portlessEnabled: boolean | undefined;
  const offerSignIn = async (): Promise<void> => {
    // The cloud login runs in a throwaway DOCKER container to capture the token
    // to ~/.agentbox, so it needs a docker image — `box.image` on the cloud path
    // can be a snapshot ref that `docker build` rejects.
    if (isCloud) {
      await a.runtime.offerCloudLogin({
        image: DEFAULT_BOX_IMAGE,
        yes: !!opts.yes,
        hostWorkspace: opts.workspace,
      });
    } else {
      await a.runtime.offerDockerLogin({
        image: cfg.box.image,
        yes: !!opts.yes,
        hostWorkspace: opts.workspace,
      });
    }
  };
  // Portless is Docker Desktop-only — skip on cloud.
  const offerPortless = async (): Promise<void> => {
    if (isCloud) return;
    portlessEnabled = await maybePromptPortless({
      engine: await detectEngine(),
      enabled: cfg.portless.enabled,
      yes: !!opts.yes,
      cwd: opts.workspace,
    });
  };

  if (a.signInOfferTiming === 'before-gates') {
    // Non-interactive (orchestrator pipe, CI): no TTY to attach or complete an
    // in-box /login, so fail fast with the same actionable message the prompt
    // would give instead of booting a box whose agent then silently sits on its
    // login screen. `-y` in a real TTY is exempt — that's the documented "boot
    // and log in inside the box" escape hatch (the user is present).
    if (!process.stdin.isTTY && (await a.runtime.requireCredsWhenNonTty?.())) {
      try {
        await assertAgentCredsAvailable({
          agent: a.spec.wireId ?? a.id,
          image: cfg.box.image,
          providerName,
          hostCredStatus: (o) => a.runtime.hostCredStatus(o),
        });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) fail(err.message);
        throw err;
      }
    }
    await offerSignIn();
    await offerPortless();
  }

  // Carry gate (agentbox.yaml's `carry:` block): resolve + ask before any
  // box work. Cancel aborts; skip proceeds with no carry payload.
  let carryEntries: ResolvedCarryEntry[] = [];
  try {
    const gate = await runCarryGate({
      projectRoot,
      yes: !!opts.yes,
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
    fail(err instanceof Error ? err.message : String(err), 1);
  }

  // Host-tool gate (agentbox.yaml's `tools:` block): a committed yaml can
  // only REQUEST host CLIs; the grant is the host's decision. Never blocks.
  try {
    await runToolsGate({ projectRoot, yes: !!opts.yes, onLog: (line) => cmdLog.write(line) });
  } catch (err) {
    log.warn(`tools: ${err instanceof Error ? err.message : String(err)}`);
  }

  carryEntries = await resolveGitCredsCarry({
    pushMode: cfg.git.pushMode,
    projectRoot,
    existing: carryEntries,
    onLog: (line) => cmdLog.write(line),
    onClose: () => cmdLog.close(),
  });

  // Whatever the agent wants to do between "config resolved" and "box built" —
  // claude's setup wizard, which can re-bake a stale base, discard a dead
  // checkpoint, and seed the first turn.
  const adjust = (await a.hooks?.beforeCreate?.({ ...ctx, checkpointRef, preflight })) ?? {};
  if (adjust.done) {
    cmdLog.close();
    return;
  }
  const effectiveCheckpointRef = 'checkpointRef' in adjust ? adjust.checkpointRef : checkpointRef;

  let effectiveArgs = agentArgs;
  if (adjust.argsTransform) effectiveArgs = adjust.argsTransform(effectiveArgs);
  effectiveArgs = applySkip(effectiveArgs);

  let fromBranch: string | undefined;
  let useBranch: string | undefined;
  try {
    ({ fromBranch, useBranch } = await resolveBranchSelection({
      useBranch: opts.useBranch,
      fromBranch: opts.fromBranch,
      repo: opts.workspace,
      providerName,
      cloudUseCurrentBranch: cfg.cloud.useCurrentBranch,
      log: (m) => cmdLog.write(m),
    }));
  } catch (err) {
    if (err instanceof FromBranchError || err instanceof UseBranchError) fail(err.message);
    throw err;
  }

  const sessionName = a.runtime.sessionNameOf(cfg);
  const seeds = preflight.seeds;
  /** True when something already owns the agent's opening turn. */
  const seedOwnsFirstTurn =
    !a.acceptsSeedPrompt || seeds.some((s) => s.ownsFirstTurn) || Boolean(adjust.seedsFirstTurn);

  if (isCloud) {
    const provider = await providerForCreate({ flag: opts.provider, config: cfg });
    // Route the create to the control box when one is configured, then adopt +
    // attach here so the agent starts. Foreground only (we already returned for
    // -i above). Teleported host state is resolved at create time, which the
    // worker path can't reproduce, so those runs stay local.
    const route = await routing();
    if (route.where === 'hub' && preflight.hubIncompatible) {
      if (opts.viaHub) log.warn(a.text.hubIncompatibleReason);
    } else if (route.where === 'hub') {
      const adopted = await withHubJobLine(
        (onStatus) =>
          createCloudBoxViaHubAndAdopt({
            providerName,
            remoteHost,
            projectRoot,
            agent: a.id,
            // The gate above already resolved + approved these; the hub path
            // used to discard them, so a hub-built box came up without files
            // the user had explicitly said yes to.
            carry: carryEntries,
            name: opts.name,
            fromBranch,
            urlFlag: opts.url,
            onStatus,
            onLog: (line) => cmdLog.write(line),
          }),
        (r) => (r ? 'box ready on the remote hub' : 'remote hub unavailable — building locally'),
        { verbose: opts.verbose === true },
      );
      if (adopted) {
        await cloudAgentAttach({
          box: adopted,
          binary: a.spec.binary,
          sessionName,
          mode: a.id,
          extraArgs: effectiveArgs,
          openIn: hostAwareOpenIn(cfgLoaded),
        });
        cmdLog.close();
        return;
      }
      // adopted === null → control box not fully configured for it; fall to local.
    } else if (route.fellBackReason) {
      log.warn(
        `control box configured but ${route.fellBackReason}; building ${providerName} box locally.`,
      );
    }

    // Cloud sign-in offer: capture a host login to ~/.agentbox so the per-box
    // push seeds it (the docker offer only seeds via the shared volume). Placed
    // after the hub route on purpose — see `offerSignIn`.
    if (a.signInOfferTiming === 'before-create') await offerSignIn();
    // browser.default = 'playwright' | 'both' implies installing playwright even
    // if box.withPlaywright wasn't explicitly set.
    const withPlaywright = cfg.box.withPlaywright || cfg.browser.default !== 'agent-browser';
    await cloudAgentCreate({
      provider,
      request: {
        workspacePath: opts.workspace,
        name: opts.name,
        checkpointRef: effectiveCheckpointRef,
        // `resolveBoxImage`, not the bare `box.image`: `agentbox prepare` pins
        // its baked base into the PER-PROVIDER key (`box.imageDaytona`, …), and
        // only this resolver reads it.
        image: resolveBoxImage(cfg, providerName),
        withPlaywright,
        withEnv: cfg.box.withEnv,
        ...(adjust.envFilesToImport ? { envFilesToImport: adjust.envFilesToImport } : {}),
        carry: carryEntries,
        vnc: { enabled: cfg.box.vnc },
        limits: resolveLimits(cfg.box, opts),
        fromBranch,
        useBranch,
        resyncOnStart: opts.resync,
        projectRoot,
        // Control-plane topology + git push routing — mirror `agentbox create`
        // so cloud boxes from the agent commands honor the same config.
        controlPlaneUrl: cfg.relay.controlPlaneUrl,
        gitPushMode: cfg.git.pushMode,
        hubGitAuth: cfg.hub.gitAuth,
        // Per-provider session-lifetime (e2b/vercel timeout); mirrors create.
        providerOptions: cloudSizingProviderOptions(provider.name, cfg, { remoteHost }),
      },
      binary: a.spec.binary,
      sessionName,
      mode: a.id,
      hasSeedPrompt: seedOwnsFirstTurn,
      extraArgs: effectiveArgs,
      verbose: opts.verbose === true,
      openIn: hostAwareOpenIn(cfgLoaded),
      attach: opts.attach !== false,
      beforeStart:
        seeds.length > 0
          ? async (box) => {
              try {
                for (const seed of seeds) {
                  await uploadTeleport({
                    box,
                    provider,
                    resolved: seed.resolved,
                    log: (line) => cmdLog.write(line),
                  });
                }
                return { agentArgsPrefix: seeds.flatMap((s) => s.forwardArgs) };
              } catch (err) {
                if (err instanceof TeleportError) fail(err.message);
                throw err;
              }
            }
          : undefined,
    });
    return;
  }

  if (a.signInOfferTiming === 'before-create') {
    // First-run sign-in offer, then the Portless opt-in — both before any box
    // work, so the user answers everything up front.
    await offerSignIn();
    await offerPortless();
  }

  // host-snapshot default off: explicit flag/config wins.
  const useSnapshot =
    opts.hostSnapshot === false
      ? false
      : opts.hostSnapshot === true
        ? true
        : (cfg.box.hostSnapshot ?? false);

  const s = makeProgressReporter(opts.verbose === true);
  s.start('creating box');
  let containerName = '';
  try {
    const withPlaywright = cfg.box.withPlaywright || cfg.browser.default !== 'agent-browser';
    const result = await createBox({
      workspacePath: opts.workspace,
      name: opts.name,
      useSnapshot,
      checkpointRef: effectiveCheckpointRef,
      fromBranch,
      useBranch,
      resyncOnStart: opts.resync,
      image: resolveBoxImage(cfg, providerName),
      // This box is FOR one agent: only its config volume, credentials and home
      // dir are wired in. Another agent can still be added on demand.
      agents: [a.id],
      ...a.runtime.createBoxConfig(a.runtime.isolateOf(cfg)),
      withPlaywright,
      withEnv: cfg.box.withEnv,
      ...(adjust.envFilesToImport ? { envFilesToImport: adjust.envFilesToImport } : {}),
      carry: carryEntries,
      vnc: { enabled: cfg.box.vnc },
      docker: { sharedCache: cfg.box.dockerCacheShared },
      portless: portlessEnabled,
      portlessStateDir: cfg.portless.stateDir || undefined,
      limits: resolveLimits(cfg.box, opts),
      projectRoot,
      onLog: (line) => {
        s.message(line);
        cmdLog.write(line);
      },
    });
    containerName = result.record.container;

    // The agent is baked into the current base image, but a box built from a
    // checkpoint captured before that agent's support won't have it — install it
    // into the box's writable layer in that case (fast no-op otherwise). Claude
    // has never done this on create; see `ensureInstalledOnCreate`.
    if (a.runtime.ensureInstalledOnCreate) {
      s.message(`checking ${a.id}`);
      cmdLog.write(`checking ${a.id}`);
      await a.runtime.ensureInstalled(result.record.container, {
        onProgress: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });
    }

    const afterCreate = await a.hooks?.afterCreate?.(result.record, {
      ...ctx,
      message: (line) => {
        s.message(line);
        cmdLog.write(line);
      },
    });

    for (const seed of seeds) {
      s.message(seed.label);
      cmdLog.write(seed.label);
      try {
        const provider = await providerForBox(result.record);
        await uploadTeleport({
          box: result.record,
          provider,
          resolved: seed.resolved,
          log: (line) => {
            s.message(clampSpinnerLine(line));
            cmdLog.write(line);
          },
        });
        effectiveArgs = [...seed.forwardArgs, ...effectiveArgs];
      } catch (err) {
        if (err instanceof TeleportError) {
          s.stop('teleport failed');
          log.error(err.message);
          log.info(
            `The box ${result.record.container} is up but unused. Destroy it with: agentbox destroy ${result.record.container} -y`,
          );
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }

    // On-create resync conflicts (checkpoint-restore path): inject as the
    // agent's opening turn, unless something already owns the first turn — then
    // it goes to stderr after the spinner stops, so it can't collide.
    const createResyncWarning = result.resync ? buildResyncWarning(result.resync) : null;
    if (createResyncWarning && !seedOwnsFirstTurn) {
      effectiveArgs = buildPromptArgs(a.spec.wireId ?? a.id, createResyncWarning, effectiveArgs);
    }

    s.message(`starting ${a.id} session`);
    await a.runtime.startSession({
      container: result.record.container,
      args: effectiveArgs,
      sessionName,
      boxName: result.record.name,
      workspacePath: result.record.workspacePath,
    });
    // Remember which agent this box was launched as, for `agentbox recover`.
    await recordLastAgent(result.record.id, a.id).catch(() => {});

    const nSuffix =
      typeof result.record.projectIndex === 'number'
        ? `  ·  n ${String(result.record.projectIndex)}`
        : '';
    s.stop(`box ready${nSuffix}`);
    if (createResyncWarning && seedOwnsFirstTurn) log.warn(createResyncWarning);
    // Anything a hook wanted to print: deferred until now, because a `log.*`
    // while the spinner is live fights it for the same line.
    for (const emit of afterCreate?.deferred ?? []) emit();

    await printLaunchRecap({
      record: result.record,
      mode: a.id,
      reattach: reattachRef(result.record),
      workspacePath: opts.workspace,
      fromBranch,
      useBranch,
      checkpointRef: effectiveCheckpointRef,
      attaching: opts.attach !== false,
    });
    if (opts.attach === false) return;
    await a.attachWrapped(
      result.record,
      sessionName,
      reattachRef(result.record),
      (m) => cmdLog.write(m),
      hostAwareOpenIn(cfgLoaded),
    );
  } catch (err) {
    s.stop('failed');
    cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    if (err instanceof a.runtime.SessionError) {
      log.error((err as Error).message);
      if (containerName) {
        log.info(`The box ${containerName} is still running. Destroy it with:`);
        log.info(`  agentbox destroy ${containerName} -y`);
      }
      cmdLog.close();
      process.exit(1);
    }
    handleLifecycleError(err);
  } finally {
    cmdLog.close();
  }
}
