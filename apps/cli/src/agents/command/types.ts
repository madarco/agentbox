/**
 * The contract between `buildAgentCommand()` and one agent.
 *
 * `agentbox claude`, `agentbox codex` and `agentbox opencode` were three
 * hand-maintained clones: 4,866 lines, of which ~1,070 were byte-identical once
 * the agent's name was normalised out. Everything an agent genuinely needs to
 * say for itself is here, split three ways:
 *
 * - {@link AgentRuntime} — the docker-side bindings and the agent's own login
 *   code. It lives in `agents/<id>/runtime.ts`, so a path that only needs to
 *   restart a session (`agent-sessions.ts`) can load it without pulling a
 *   commander tree behind it.
 * - {@link AgentCommandText} — the strings that differ. Almost every option's
 *   help is identical modulo the agent name; only the ones that are genuinely
 *   different are slots here, and `test/_fixtures/agent-cli-surface.json` is
 *   what proves the rest really were the same.
 * - {@link AgentCommandHooks} — the five places an agent runs its OWN code
 *   inside the shared body. Deliberately a closed, small set: if an agent needs
 *   a sixth, the body is not actually shared and forking it is the honest answer.
 */
import type { AttachOpenIn, EffectiveConfig, UserConfig } from '@agentbox/config';
import type { AgentId, ResolvedCarryEntry } from '@agentbox/core';
import type { BoxRecord, CreateBoxOptions } from '@agentbox/sandbox-docker';
import type { CreateRouting } from '../../control-plane/route-create.js';
import type { WrappedAttachOptions } from '../../wrapped-pty/index.js';
import type { Command } from 'commander';
import type { AgentLoginBinding } from '../../lib/agent-login-bindings.js';
import type { ResolvedTeleport } from '../../session-teleport/index.js';
import type { AgentSyncSpec } from '@agentbox/sandbox-core';

/** Result of an agent's guided-or-passthrough sign-in. */
export interface SignInResult {
  ok: boolean;
  error?: string;
  cancelled?: boolean;
}

/** Extra wrapped-attach wiring only some agents have (claude's clipboard paste). */
export type AttachExtras = Pick<WrappedAttachOptions, 'onPasteImage' | 'onPasteImageFile'>;

/**
 * How the box's recorded session is brought back — read by `agent-sessions.ts`
 * on restart/unpause, and by `<agent> attach` when a down box comes back up.
 * Absent for an agent whose registry row says `caps.resume: false`.
 */
export interface AgentResumeSupport {
  /**
   * Args that resume the box's recorded session, or null if there is none.
   * `exec` runs a read-only shell snippet in the box and returns its trimmed
   * stdout ('' on any failure) — the probe is a pointer file the in-box activity
   * hooks maintain.
   *
   * The result is always APPENDED to the user's args, never prepended: codex's
   * `resume` is a subcommand that must follow the global flags, and claude's
   * `--resume <id>` is order-insensitive, so one rule covers both.
   */
  resumeArgs(exec: (script: string) => Promise<string>): Promise<string[] | null>;
}

/** The docker-side bindings + login code for one agent. */
export interface AgentRuntime {
  /** Shared docker config volume — the one a throwaway login container writes. */
  sharedVolume: string;
  /** Thrown when the in-box tmux session cannot be started; caught by name. */
  SessionError: new (...args: never[]) => Error;

  startSession(o: {
    container: string;
    args: string[];
    sessionName: string;
    boxName: string;
    workspacePath: string;
  }): Promise<void>;
  sessionInfo(container: string, sessionName: string): Promise<{ running: boolean }>;
  ensureInstalled(container: string, o: { onProgress: (line: string) => void }): Promise<unknown>;
  ensureVolume(
    target: { volume: string },
    o: { syncFromHost: boolean; image: string; hostWorkspace?: string },
  ): Promise<unknown>;
  buildAttachArgv(container: string, sessionName: string | undefined): string[];

  /**
   * The volume `<agent> start` rsyncs the host config into, or undefined to skip
   * the sync entirely. Not the same question for every agent: claude falls back
   * to the shared volume (its config always syncs), while codex and opencode
   * skip when the box has no volume of theirs mounted — a box created by a plain
   * `agentbox create` on a host with no such config.
   */
  resolveConfigVolume(box: BoxRecord): string | undefined;
  /** The `createBox` per-agent config option (`{ codexConfig: { isolate } }`). */
  createBoxConfig(isolate: boolean): Partial<CreateBoxOptions>;

  /** `<agent>.sessionName` — a typed accessor, because `@agentbox/config` is a
   *  zero-dependency leaf and cannot read the agent registry to generate keys. */
  sessionNameOf(cfg: EffectiveConfig): string;
  /** `box.isolate<Agent>Config`. */
  isolateOf(cfg: EffectiveConfig): boolean;
  /**
   * Per-invocation config overrides this agent's own flags produce:
   * `--session-name`, `--dangerously-skip-permissions` and
   * `--isolate-<id>-config`. Returned as a `UserConfig` fragment because the
   * keys live under per-agent blocks (`codex.sessionName`,
   * `box.isolateCodexConfig`) that `@agentbox/config` cannot generate — it is a
   * zero-dependency leaf with no access to the agent registry.
   */
  cliOverrides(o: {
    sessionName?: string;
    skipPermissions?: boolean;
    isolate?: boolean;
  }): Partial<UserConfig>;

  /**
   * The agent's "never prompt me" flag, or null when it has none (opencode).
   * Non-null is also what makes the command grow
   * `--dangerously-skip-permissions` / `--no-…`.
   */
  skipPermissions: {
    /** The flag as the agent spells it — quoted in this option's help. */
    flag: string;
    /** What the flag does, in the user's words: `auto-accept tool use`. */
    effect: string;
    /** Prepend the flag unless the user already governed that surface. */
    apply(args: string[], cfg: EffectiveConfig): string[];
  } | null;

  /** First-run sign-in offer before a DOCKER box is built. Silent no-op when
   *  already authenticated / non-TTY / `--yes`. */
  offerDockerLogin(o: { image: string; yes: boolean; hostWorkspace: string }): Promise<void>;
  /** Same offer before a CLOUD box: cloud has no shared volume, so the login has
   *  to land in the host backup for the per-box push to seed. */
  offerCloudLogin(o: { image: string; yes: boolean; hostWorkspace: string }): Promise<void>;
  /** The `<agent> login` subcommand's sign-in: guided under a pty, or the
   *  agent's own TUI when forced / unavailable. */
  signIn(image: string, extraArgs: string[], o: { passthrough?: boolean }): Promise<SignInResult>;
  /** Guided-login binding — used by `agentbox <agent> login` machinery. */
  loginBinding(o: {
    image: string;
    extraArgs?: string[];
    writeLog?: (line: string) => void;
  }): AgentLoginBinding;
  /**
   * Whether `<agent> login` needs a terminal. `always` for a flow that prompts
   * (opencode's provider picker); `interactive-only` when the guided flow needs
   * no keystroke at all (codex's device code) and only the `--interactive`
   * passthrough does.
   */
  loginNeedsTty: 'always' | 'interactive-only';
  /**
   * Whether a non-TTY run must already have usable credentials. True for claude:
   * without a terminal there is no way to complete an in-box login, so booting a
   * box whose agent then sits on its login screen wastes the user's time. Absent
   * means "don't check".
   */
  requireCredsWhenNonTty?(): Promise<boolean>;
  /** An agent whose login is a protocol of its own replaces the default
   *  subcommand body here — see `command/login.ts`. */
  loginCommand?: {
    /** Extra flags, declared BEFORE `--interactive`. */
    options?(cmd: Command): void;
    /** Replaces the whole action. */
    run(args: string[], opts: Record<string, unknown>): Promise<void>;
  };
  /**
   * Whether `agentbox <agent>` probes for the binary on a freshly created box.
   * False for claude, which never has: its create always derives an image with
   * the agent baked in. Turning it on would be a behavior change on the daily
   * driver's hot path, so it stays declared rather than silently unified.
   */
  ensureInstalledOnCreate: boolean;

  resume?: AgentResumeSupport;
}

/** Per-agent help strings that are genuinely different, not just re-spelled. */
export interface AgentCommandText {
  /** Parent command description. */
  description: string;
  /** `--isolate-<id>-config`: the volume as the user thinks of it (`~/.codex`). */
  isolateVolumeLabel: string;
  /** `start --no-sync-config`: what gets rsynced (`~/.codex`, `OpenCode config`). */
  syncConfigLabel: string;
  /** Example args after `--`, e.g. `-m gpt-5.4`. */
  argsExample: string;
  /** Appended to `-v, --verbose`'s description. */
  verboseExtra?: string;
  /** Appended to `-i, --initial-prompt`'s description. */
  initialPromptExtra?: string;
  /** How this agent names a session handle: `id` or `uuid`. */
  resumeIdWord: string;
  /** `-c` / `--resume` help. Replaced wholesale when `caps.teleport` is a stub. */
  continueHelp: string;
  resumeHelp: string;
  /** Same two, on the `start` subcommand (shorter — no "and resume from it"). */
  startContinueHelp: string;
  startResumeHelp: string;
  attachDescription: string;
  startDescription: string;
  /** Refusal when `--resume`/`-c` targets a box whose session is already live. */
  resumeIntoRunningError(boxName: string): string;
  loginDescription: string;
  loginArgsHelp: string;
  loginInteractiveHelp: string;
}

/** What the create body has already resolved when a hook runs. */
export interface AgentCreateContext {
  opts: Record<string, unknown>;
  /**
   * Whether this create runs on the control box or here — resolved lazily and
   * memoised. Claude's setup wizard has to know before it can decide whether
   * this machine's stale base is even going to be used; the other agents only
   * ask inside the cloud branch, and a docker run that never asks never pays
   * the control-box round trip.
   */
  routing(): Promise<CreateRouting>;
  /** Host workspace (`-w`). */
  workspace: string;
  cfg: EffectiveConfig;
  projectRoot: string;
  providerName: string;
  /** Append a line to `~/.agentbox/logs/<agent>.log`. */
  writeLog(line: string): void;
  /** Close the command log and exit — hooks that refuse must not leak the fd. */
  fail(message: string, code?: number): never;
}

/**
 * A host-side payload prepared BEFORE any box work, uploaded once the box
 * exists. Session teleport and claude's `--plan` are the same shape: resolve on
 * the host so a bad session id fails before the user pays for a box, upload
 * after create, then optionally prefix the agent's argv.
 */
export interface PreparedSeed {
  /** Progress label, e.g. `uploading claude session into box`. */
  label: string;
  /** Free-form marker so a later hook can find the seed it produced. */
  tag?: string;
  resolved: ResolvedTeleport;
  /** Args prefixed onto the agent's argv once the upload succeeds. */
  forwardArgs: string[];
  /** True when this seed owns the agent's opening turn, so a resync conflict
   *  warning goes to stderr instead of being injected as a prompt. */
  ownsFirstTurn: boolean;
}

export interface AgentPreflight {
  seeds: PreparedSeed[];
  /** Forces a local build even when a control box is configured — host state
   *  teleported at create time cannot be reproduced by the hub worker. */
  hubIncompatible?: boolean;
  /** Why, for the `--via-hub is ignored` warning. */
  hubIncompatibleReason?: string;
}

/** Adjustments a `beforeCreate` hook can make (claude's setup wizard). */
export interface AgentCreateAdjust {
  /**
   * Replace the resolved checkpoint. Present-but-undefined means "drop it" (the
   * wizard discarding a stale or dead default), which is why the body tests for
   * the KEY rather than for a truthy value.
   */
  checkpointRef?: string | undefined;
  /** Rewrite the agent's argv before skip-permissions is layered on. */
  argsTransform?: (args: string[]) => string[];
  /** True when `argsTransform` seeded the agent's opening turn, so a resync
   *  conflict warning must go to stderr instead of becoming a second prompt. */
  seedsFirstTurn?: boolean;
  /** Host files to copy into `/workspace` at create time (the wizard's
   *  env-import multiselect). */
  envFilesToImport?: string[];
  /** Stop here — the hook already did the work (or the user cancelled). */
  done?: boolean;
}

/** What `beforeCreate` additionally knows: the body has resolved both by then. */
export interface AgentBeforeCreateContext extends AgentCreateContext {
  /** The checkpoint the box would boot from, before any hook adjusts it. */
  checkpointRef: string | undefined;
  preflight: AgentPreflight;
}

export interface AgentCommandHooks {
  /**
   * Resolve host state before any box work: session teleport, claude's `--plan`,
   * and the mutual-exclusion checks between them and `-i`.
   */
  preflight?(ctx: AgentCreateContext): Promise<AgentPreflight>;
  /** Runs after the gates and before the box is created. */
  beforeCreate?(ctx: AgentBeforeCreateContext): Promise<AgentCreateAdjust>;
  /**
   * Runs on a freshly created docker box, before the agent session starts.
   * Returns lines to log AFTER the spinner stops (claude's plugin-cache prune),
   * so they don't get overwritten by the next spinner message.
   */
  afterCreate?(
    box: BoxRecord,
    ctx: AgentCreateContext & { message: (line: string) => void },
  ): Promise<HookOutput | void>;
  /**
   * Runs on `<agent> start` / `<agent> attach` after the config volume is
   * synced, before the agent is launched — hook/plugin seeding.
   */
  afterVolumeSync?(
    box: BoxRecord,
    o: { volume: string; message: (line: string) => void },
  ): Promise<HookOutput | void>;
  /** Extra wrapped-attach wiring (claude's clipboard paste handlers). */
  attachExtras?(box: BoxRecord): Promise<AttachExtras>;
  /** Last word on the built command — extra options, extra subcommands. */
  extendCommand?(cmd: Command, subcommands: AgentSubcommands): void;
}

/**
 * What a hook that runs UNDER the spinner hands back. Anything it wants the user
 * to read has to wait for `spinner.stop()` — a `log.warn` while the spinner is
 * live fights it for the line — so the hook returns callbacks instead of
 * printing.
 */
export interface HookOutput {
  deferred?: (() => void)[];
}

/** The subcommands the factory built, handed to `extendCommand`. */
export interface AgentSubcommands {
  attach: Command;
  start: Command;
  login: Command;
}

export interface AgentCliSpec {
  id: AgentId;
  /** The registry row, by reference. */
  spec: AgentSyncSpec;
  /** Product name in prose: `Claude Code`, `OpenAI Codex`, `OpenCode`. */
  productName: string;
  /** Short name for intro/outro lines: `Claude`, `Codex`, `OpenCode`. */
  shortName: string;
  runtime: AgentRuntime;
  text: AgentCommandText;
  hooks?: AgentCommandHooks;
  /**
   * Whether this agent's launch can carry an opening turn. False for OpenCode,
   * whose interactive launch takes no seed prompt at all — so a resync-conflict
   * warning is always surfaced on stderr rather than injected.
   */
  acceptsSeedPrompt: boolean;
  /**
   * When the first-run sign-in offer and the Portless opt-in are asked.
   *
   * `before-gates` (claude) puts them ahead of the carry gate and the setup
   * wizard, so the user has signed in before the wizard can spend minutes
   * re-baking a stale base. `before-create` (codex, opencode) puts them right
   * before the box is built, which on the cloud path is AFTER the hub-routing
   * decision — so a box the control box is going to build never prompts for a
   * local login it will not use. Both orders are deliberate; unifying them would
   * lose one of the two properties.
   */
  signInOfferTiming: 'before-gates' | 'before-create';
  /** Attach to this agent's tmux session through the wrapped-pty footer. Built
   *  by the factory from the runtime bindings; set here so the create body can
   *  finish by attaching. */
  attachWrapped: AttachWrapped;
}

/** Attach entry point: never returns (ends in `process.exit`). */
export type AttachWrapped = (
  box: BoxRecord,
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
) => Promise<never>;

/** Carry entries resolved by the create body's gates. */
export type CarryEntries = ResolvedCarryEntry[];
