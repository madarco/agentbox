/**
 * The shared body of `agentbox <agent> start` and `agentbox <agent> attach`.
 *
 * Both subcommands funnel into {@link startOrAttach}: if a session is already
 * running, just attach; otherwise auto-unpause/start the box, optionally resync
 * the agent's config into its volume, launch the agent, then attach. Cloud boxes
 * short-circuit to the SDK attach path before any of that.
 */
import { loadEffectiveConfig, type EffectiveConfig, type UserConfig } from '@agentbox/config';
import {
  inspectBox,
  recordLastAgent,
  seedAgentDeclaredFiles,
  startBox,
  unpauseBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import type { Command } from 'commander';
import { intro, log, outro, spinner } from '../../lib/prompt.js';
import { reattachRef, resolveBoxOrExit, resolveBoxOrShift } from '../../box-ref.js';
import { agentResumeArgs } from '../../agent-sessions.js';
import { buildPromptArgs } from '../../lib/queue/build-prompt-args.js';
import { hostAwareOpenIn } from '../../terminal/host.js';
import { maybeResyncWorkspace } from '../../lib/resync-start.js';
import { resolveAttachInOption } from '../../commands/_attach-in.js';
import { cloudAgentAttach, cloudAgentStartDetached } from '../../commands/_cloud-attach.js';
import { handleLifecycleError } from '../../commands/_errors.js';
import { providerForBox } from '../../provider/registry.js';
import { seedAgentDeclaredFilesViaTransport } from '@agentbox/sandbox-cloud';
import {
  prepareTeleport,
  TeleportError,
  uploadTeleport,
  type ResolvedTeleport,
  type ResumeMode,
} from '../../session-teleport/index.js';
import { clampSpinnerLine } from '../../spinner-line.js';
import type { AgentStartOptions } from './options.js';
import type { AgentCliSpec } from './types.js';

/**
 * The tmux session `<agent> attach` / `<agent> start` should target: the
 * explicit `--session-name`, else the CONFIGURED name.
 *
 * The cloud branches used to fall back to the registry default instead of the
 * config — three copies of `opts.sessionName ?? 'codex'` — while the docker
 * branch read `<agent>.sessionName`. With a custom session name that meant
 * create started one session and a later cloud attach targeted another, silently
 * creating a second one. Pre-existing in all three hand-written commands; fixing
 * it is one line now that there is one.
 */
/**
 * Place the agent's declared `seeds` into a live CLOUD box. Best-effort and
 * silent on failure: these files (activity hooks, the state plugin) make a box
 * report richer status, and not getting them must never block a launch.
 */
async function seedCloudAgentFiles(box: BoxRecord, agent: string): Promise<void> {
  try {
    const provider = await providerForBox(box);
    if (!provider.syncTransport) return;
    await seedAgentDeclaredFilesViaTransport(provider.syncTransport(box), agent);
  } catch {
    // best-effort
  }
}

export function resolveSessionName(
  a: AgentCliSpec,
  opts: AgentStartOptions,
  cfg: EffectiveConfig,
): string {
  return opts.sessionName ?? a.runtime.sessionNameOf(cfg);
}

/**
 * Shared by `<agent> start` and `<agent> attach`. `resumePrepared` is a host
 * session already resolved by the caller (teleport); it is uploaded once the box
 * is up and its flags ride ahead of the user's args.
 */
async function startOrAttach(
  a: AgentCliSpec,
  box: BoxRecord,
  agentArgs: string[],
  opts: AgentStartOptions,
  resumePrepared?: ResolvedTeleport | null,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = a.runtime.cliOverrides({
    sessionName: opts.sessionName,
    skipPermissions: opts.dangerouslySkipPermissions,
  });
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  if (opts.resync !== undefined)
    cliOverrides.box = { ...cliOverrides.box, resyncOnStart: opts.resync };
  const cfgLoaded = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const cfg = cfgLoaded.effective;
  const sessionName = a.runtime.sessionNameOf(cfg);
  const openIn = hostAwareOpenIn(cfgLoaded);
  const wantAttach = opts.attach !== false;

  // Auto-unpause/start. Mirrors `agentbox shell` / `agentbox code`. `startBox`
  // relaunches ctl/vnc/dockerd, because those processes die with the container.
  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
  // Record this attach/launch so `agentbox recover` knows which agent to bring
  // back. Best-effort — never block the launch.
  await recordLastAgent(box.id, a.id).catch(() => {});

  // If a tmux session already exists, just attach — no resync, ignore any
  // post-`--` args (they only apply to a fresh launch).
  const existing = await a.runtime.sessionInfo(box.container, sessionName);
  if (existing.running) {
    if (resumePrepared) throw new Error(a.text.resumeIntoRunningError(box.name));
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox ${a.id} attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await a.attachWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  // First-run sign-in offer — before any box prep.
  await a.runtime.offerDockerLogin({
    image: box.image,
    yes: false,
    hostWorkspace: box.workspacePath,
  });

  // One spinner for the whole prepare→attach sequence: every phase overwrites
  // the single line instead of leaving a scroll of `●`/`◇` rows.
  const s = spinner();
  s.start('preparing box');

  const wasDown = insp.state === 'paused' || insp.state === 'stopped';
  if (insp.state === 'paused') {
    s.message('unpausing box');
    await unpauseBox(box.id);
  } else if (insp.state === 'stopped') {
    s.message('starting box');
    await startBox(box.id);
  }

  // Resync the workspace with the host (merge host's current branch + overlay
  // its uncommitted/untracked changes, box wins on conflict). Gated to docker
  // and to the down→up transition: a box that was already running may have a
  // live agent session whose files we must not mutate underneath it. We're past
  // the `existing.running` early-return, so this agent isn't live.
  const resyncWarning = await maybeResyncWorkspace({
    box,
    enabled: cfg.box.resyncOnStart && wasDown,
    projectRoot: cfgLoaded.projectRoot,
    spinner: s,
  });

  // Re-sync the host's config into the box volume so host-side changes (new MCP
  // servers, refreshed auth state, …) reach the in-box agent. Runs for
  // `<agent> start` (opt out with --no-sync-config), never for `<agent> attach`
  // — a plain reattach must not clobber the in-box state with the host copy.
  const volume = a.runtime.resolveConfigVolume(box);
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig && volume) {
    s.message(`syncing ${a.text.syncConfigLabel} into box volume`);
    await a.runtime.ensureVolume(
      { volume },
      { syncFromHost: true, image: box.image, hostWorkspace: box.workspacePath },
    );
  }
  // Box-only, image-versioned seeding. The DECLARED files (`spec.seeds`:
  // codex's activity hooks, opencode's state plugin, claude's setup skill) are
  // placed for every agent from one call; the hook is only for the rest
  // (claude's credential mirror + plugin native deps). Runs even with
  // --no-sync-config so an image upgrade still propagates.
  if (volume) await seedAgentDeclaredFiles(a.id, volume, box.image);
  const seeded = volume
    ? await a.hooks?.afterVolumeSync?.(box, {
        volume,
        message: (line) => s.message(clampSpinnerLine(line)),
      })
    : undefined;

  // Install the agent if this box's image lacks it — a box created for another
  // agent, or from a checkpoint predating the agent selection. No-op otherwise.
  s.message(`checking ${a.id}`);
  await a.runtime.ensureInstalled(box.container, {
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  let effectiveArgs = a.runtime.skipPermissions
    ? a.runtime.skipPermissions.apply(agentArgs, cfg)
    : agentArgs;
  // Attach path on a box that just came back up: resume the box's recorded
  // session rather than starting fresh. Only when the user gave no args of their
  // own, isn't teleporting a host session, and the box actually has one.
  let attachResumed = false;
  if (opts.attachResume && agentArgs.length === 0 && !resumePrepared && a.spec.caps.resume) {
    const provider = await providerForBox(box);
    const resume = await agentResumeArgs(provider, box, a.id);
    if (resume) {
      // Appended, not prepended: codex's `resume` is a SUBCOMMAND and has to
      // follow the global flags in `effectiveArgs`.
      effectiveArgs = [...effectiveArgs, ...resume];
      attachResumed = true;
    }
  }
  if (resumePrepared) {
    s.message(`uploading ${a.id} session into box`);
    try {
      const provider = await providerForBox(box);
      await uploadTeleport({
        box,
        provider,
        resolved: resumePrepared,
        log: (line) => s.message(clampSpinnerLine(line)),
      });
      effectiveArgs = [...resumePrepared.forwardArgs, ...effectiveArgs];
    } catch (err) {
      if (err instanceof TeleportError) {
        s.stop('teleport failed');
        log.error(err.message);
        process.exit(2);
      }
      throw err;
    }
  }

  // Inject the resync conflict warning as the agent's opening turn. A resumed
  // session (teleport, or an attach-resume into the in-box session) rides resume
  // flags with no clean first user turn, so surface it on stderr after the
  // spinner stops instead — a seed prompt would collide.
  const ownsFirstTurn = !a.acceptsSeedPrompt || Boolean(resumePrepared) || attachResumed;
  if (resyncWarning && !ownsFirstTurn) {
    effectiveArgs = buildPromptArgs(a.spec.wireId ?? a.id, resyncWarning, effectiveArgs);
  }

  s.message(`starting ${a.id} session`);
  await a.runtime.startSession({
    container: box.container,
    args: effectiveArgs,
    sessionName,
    boxName: box.name,
    workspacePath: box.workspacePath,
  });

  s.stop(`box ${box.container} ready`);
  if (resyncWarning && ownsFirstTurn) log.warn(resyncWarning);
  for (const emit of seeded?.deferred ?? []) emit();

  if (!wantAttach) {
    outro(
      `session "${sessionName}" started — attach with: agentbox ${a.id} attach ${reattachRef(box)}`,
    );
    return;
  }
  outro(`attaching — Control+a d to detach, leaves ${a.id} running`);
  await a.attachWrapped(box, sessionName, reattachRef(box), undefined, openIn);
}

/** `agentbox <agent> attach [box]`. */
export function wireAttachAction(a: AgentCliSpec, cmd: Command): Command {
  return cmd.action(async function (this: Command, idOrName: string | undefined) {
    // optsWithGlobals merges parent + own options — the parent command also
    // defines `--session-name`.
    const opts = this.optsWithGlobals() as AgentStartOptions;
    intro(`Attaching to ${a.shortName} session...`);
    try {
      const attachIn = resolveAttachInOption(opts);
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        // Cloud twin of the docker volume seed above. Also the self-heal path:
        // a box created before its agent declared `seeds` (or before the cloud
        // side seeded at all) picks the files up on its next start rather than
        // needing a re-create.
        await seedCloudAgentFiles(box, a.id);
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: a.spec.binary,
          sessionName: resolveSessionName(a, opts, cfg.effective),
          mode: a.id,
          openIn: hostAwareOpenIn(cfg),
        });
        return;
      }
      // A plain reattach must never touch host config. Force syncConfig off so
      // the no-session path starts a fresh session without the host→volume
      // rsync (which would overwrite the in-box state).
      await startOrAttach(a, box, [], { ...opts, syncConfig: false, attachResume: true });
    } catch (err) {
      if (err instanceof a.runtime.SessionError) {
        log.error((err as Error).message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });
}

/** `agentbox <agent> start [box] [-- args...]`. */
export function wireStartAction(a: AgentCliSpec, cmd: Command): Command {
  return cmd.action(async function (
    this: Command,
    idOrName: string | undefined,
    agentArgs: string[],
  ) {
    const opts = this.optsWithGlobals() as AgentStartOptions;
    intro(`Starting ${a.shortName} in a box...`);
    try {
      const attachIn = resolveAttachInOption(opts);
      // Two positionals (`[box] [<agent>-args...]`) make commander bind the
      // first post-`--` token to `[box]`. resolveBoxOrShift detects that,
      // auto-picks the project's single box, and tells us to treat the bound
      // `idOrName` as the first agent-args token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      let effectiveArgs = shifted && idOrName ? [idOrName, ...agentArgs] : agentArgs;
      let resumeMode: ResumeMode | null = null;
      if (opts.continue === true && opts.resume) {
        log.error('only one of -c / --continue / --resume can be passed');
        process.exit(2);
      }
      if (opts.continue === true) resumeMode = { kind: 'continue' };
      else if (opts.resume) resumeMode = { kind: 'resume', id: opts.resume };
      let resumePrepared: ResolvedTeleport | null = null;
      if (resumeMode) {
        try {
          // Refuses on `caps.teleport: 'stub'` with the reason the registry row
          // carries, so an agent without teleport needs no branch here.
          resumePrepared = await prepareTeleport({
            agent: a.id,
            hostCwd: box.workspacePath,
            mode: resumeMode,
          });
        } catch (err) {
          if (err instanceof TeleportError) {
            log.error(err.message);
            process.exit(2);
          }
          throw err;
        }
      }
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: {
            ...(attachIn ? { attach: { openIn: attachIn } } : {}),
            ...(opts.dangerouslySkipPermissions !== undefined
              ? a.runtime.cliOverrides({ skipPermissions: opts.dangerouslySkipPermissions })
              : {}),
          },
        });
        if (a.runtime.skipPermissions) {
          effectiveArgs = a.runtime.skipPermissions.apply(effectiveArgs, cfg.effective);
        }
        if (resumePrepared) {
          try {
            const provider = await providerForBox(box);
            await uploadTeleport({ box, provider, resolved: resumePrepared });
            effectiveArgs = [...resumePrepared.forwardArgs, ...effectiveArgs];
          } catch (err) {
            if (err instanceof TeleportError) {
              log.error(err.message);
              process.exit(2);
            }
            throw err;
          }
        }
        const sessionName = resolveSessionName(a, opts, cfg.effective);
        if (opts.attach === false) {
          // Background mode: start the detached session (matches docker) instead
          // of deferring the agent until the next attach.
          await cloudAgentStartDetached({
            box,
            binary: a.spec.binary,
            sessionName,
            extraArgs: effectiveArgs,
          });
          outro(
            `--no-attach: ${a.id} started in background. Attach: agentbox ${a.id} attach ${reattachRef(box)}`,
          );
          return;
        }
        await cloudAgentAttach({
          box,
          binary: a.spec.binary,
          sessionName,
          mode: a.id,
          extraArgs: effectiveArgs,
          openIn: hostAwareOpenIn(cfg),
        });
        return;
      }
      await startOrAttach(a, box, effectiveArgs, opts, resumePrepared);
    } catch (err) {
      if (err instanceof a.runtime.SessionError) {
        log.error((err as Error).message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });
}
