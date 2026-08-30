/**
 * The option surface every agent command shares, and the option types behind it.
 *
 * `claude`, `codex` and `opencode` declared the same 38 options in the same
 * order, differing only in the agent's name inside the help text; claude added
 * `--plan` at the end and opencode dropped the two skip-permissions flags.
 * `test/_fixtures/agent-cli-surface.json` is what asserts that description of
 * reality is exact, flag for flag.
 */
import { Command } from 'commander';
import { ATTACH_IN_HELP, INLINE_HELP, NO_ATTACH_HELP } from '../../commands/_attach-in.js';
import type { AgentCliSpec } from './types.js';

/** Flags shared by the create action and both subcommands. */
export interface AgentCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  /** `--snapshot <ref>`: start from this checkpoint. */
  snapshot?: string;
  image?: string;
  yes?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** `--dangerously-skip-permissions` / `--no-…`: per-box override of the
   *  agent's `dangerouslySkipPermissions` config. Absent for agents with no
   *  such flag. */
  dangerouslySkipPermissions?: boolean;
  /** `--carry-yes` (or AGENTBOX_CARRY_YES=1): auto-approve the carry: block. */
  carryYes?: boolean;
  /** `--carry <mode>`: 'skip' disables carry for this run (also AGENTBOX_CARRY=skip). */
  carry?: 'skip' | 'ask';
  /** `--dangerously-with-credentials`: copy a git credential into the box
   *  (git.pushMode=direct); cloud only. Token-vs-SSH is chosen ONLY at the
   *  interactive prompt (TTY required). */
  dangerouslyWithCredentials?: boolean;
  vnc?: boolean;
  resync?: boolean;
  sharedDockerCache?: boolean;
  portless?: boolean;
  sessionName?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** Sandbox backend: `docker` (default) or a cloud provider. */
  provider?: string;
  fromBranch?: string;
  useBranch?: string;
  viaHub?: boolean;
  local?: boolean;
  url?: string;
  verbose?: boolean;
  /** Raw `--attach-in <mode>` value; validated by `parseAttachInOption`. */
  attachIn?: string;
  /** `--inline`: shortcut for `--attach-in same` (long-form only — `-i` is
   *  `--initial-prompt`). */
  inline?: boolean;
  /** Commander parses `-d, --no-attach` as `attach: false` (defaults true). */
  attach?: boolean;
  initialPrompt?: string;
  maxRunning?: string;
  maxWorking?: string;
  continue?: boolean;
  resume?: string;
  /** claude only, via `extendCommand`. */
  plan?: string;
  /** The per-agent isolate flag, normalised by the factory (commander names it
   *  `isolateClaudeConfig` / `isolateCodexConfig` / `isolateOpencodeConfig`). */
  [isolateKey: string]: unknown;
}

export interface AgentStartOptions {
  sessionName?: string;
  /** Inherited from the parent command via `optsWithGlobals`. */
  dangerouslySkipPermissions?: boolean;
  resync?: boolean;
  syncConfig?: boolean;
  attachIn?: string;
  inline?: boolean;
  attach?: boolean;
  continue?: boolean;
  resume?: string;
  /** Set by the `attach` subcommand: resume the in-box session when bringing a
   *  down box back up, so attach after a stop is seamless. Not set by the bare
   *  command or by `start` (those stay fresh). */
  attachResume?: boolean;
}

/** The commander option name the `--isolate-<id>-config` flag lands under. */
export function isolateOptionKey(id: string): string {
  return `isolate${id.charAt(0).toUpperCase()}${id.slice(1)}Config`;
}

const BOX_REF_HELP =
  'box ref: project index, id, id prefix, name, or container (default: the only box in this project)';

/**
 * Declare the create-command option surface on `cmd`, in the order the three
 * hand-written commands used. Order is part of the contract: it is what
 * `--help` prints.
 */
export function addCreateOptions(cmd: Command, a: AgentCliSpec): Command {
  const { id, productName, text } = a;
  cmd
    // Mirror create's surface so users can swap the verb without re-learning flags.
    .option('-w, --workspace <path>', 'host workspace to mount', process.cwd())
    .option('-n, --name <name>', 'friendly box name (default: <workspace-basename>-<id>)')
    .option(
      '--host-snapshot',
      'APFS-clone the host workspace into a per-box scratch dir before seeding /workspace (stabilizes the tar-pipe source)',
    )
    .option('--no-host-snapshot', 'tar-pipe directly from the live host workspace at create time')
    .option(
      '--snapshot <ref>',
      'start from a project checkpoint (see `agentbox checkpoint`); overrides box.defaultCheckpoint',
    )
    .option('--image <ref>', 'override the box image')
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
      '--dangerously-with-credentials',
      "copy a git credential INTO the box so it can push with your PC off. You'll be asked at an interactive prompt to choose 'token' (HTTPS, unsigned commits, smallest exposure) or your 'ssh' private key (signs commits, riskiest). DANGEROUS: the credential lives in the box and its snapshots. Requires a real terminal (no non-interactive / CI path). Cloud only. Sets git.pushMode=direct.",
    )
    .option(
      `--isolate-${id}-config`,
      `use a per-box ${text.isolateVolumeLabel} volume instead of the shared agentbox-${id}-config`,
    )
    .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box');
  if (a.runtime.skipPermissions) {
    const { flag, effect } = a.runtime.skipPermissions;
    cmd
      .option(
        '--dangerously-skip-permissions',
        `launch ${id} with ${flag} (${effect}); on by default since boxes are isolated`,
      )
      .option('--no-dangerously-skip-permissions', `do not pass ${flag} to ${id} in this box`);
  }
  cmd
    .option(
      '--with-env',
      'copy host env/config files (.env*, secrets.toml, agentbox.yaml, ...) into /workspace at create time (gitignore-bypassing)',
    )
    .option('--no-vnc', 'disable the per-box Xvnc + noVNC web client (on by default)')
    .option(
      '--no-resync',
      "do not sync the box with the host on start (default: merge the host's current branch + overlay its uncommitted/untracked changes, keeping the box's version on conflict)",
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
    .option(
      '--session-name <name>',
      `tmux session name (default from config; built-in: ${a.spec.sessionName})`,
    )
    .option('--memory <size>', 'memory ceiling (e.g. 512m, 2g); unset = unlimited')
    .option('--cpus <n>', 'CPU count cap (fractional ok, e.g. 1.5); unset = unlimited')
    .option('--pids-limit <n>', 'max process count (PIDs cgroup); unset = unlimited')
    .option('--disk <size>', 'best-effort writable-layer size (e.g. 10g); no-op on overlay2/macOS')
    .option('--provider <name>', "sandbox backend: 'docker' (default) or 'daytona' for a cloud box")
    .option(
      '--from-branch <ref>',
      "base the box's per-box branch on this ref (branch / tag / SHA) instead of HEAD. Branch/tag names are fetched from origin first.",
    )
    .option(
      '-b, --use-branch <name>',
      'reuse an existing branch directly instead of forking agentbox/<box-name>. Commits/pushes flow straight to it. Docker fails if the host already has it checked out. Mutually exclusive with --from-branch.',
    )
    .option(
      '--via-hub',
      'force building this cloud box on the control box (then adopt + attach here). When a control box is configured this is already the default for foreground cloud runs (cloud.viaHub). Ignored for docker.',
    )
    .option(
      '--local',
      'force building the box on this machine even when a control box is configured (the opposite of --via-hub).',
    )
    .option('--url <url>', 'control-box URL for the hub route (default: relay.controlPlaneUrl)')
    .option(
      '-v, --verbose',
      `bypass the spinner and stream raw provider output${text.verboseExtra ?? ''} to stderr. The same content always lands in ~/.agentbox/logs/${id}.log.`,
    )
    .option('--attach-in <mode>', ATTACH_IN_HELP)
    .option('--inline', INLINE_HELP)
    .option('-d, --no-attach', NO_ATTACH_HELP)
    .option(
      '-i, --initial-prompt <text>',
      `seed the ${id} session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent).${text.initialPromptExtra ?? ''}`,
    )
    .option(
      '--max-running <n>',
      'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
    )
    .option(
      '--max-working <n>',
      'per-invocation override of queue.maxWorking; only honored when `-i` is set',
    )
    .option('-c, --continue', text.continueHelp)
    .option('--resume <id>', text.resumeHelp)
    .argument(
      `[${id}-args...]`,
      `extra args passed to ${id} inside the box; place after \`--\`, e.g. \`agentbox ${id} -- ${text.argsExample}\``,
    );
  cmd.description(`Create a sandboxed box and launch ${productName} in a detachable tmux session`);
  return cmd;
}

export function buildAttachSubcommand(a: AgentCliSpec): Command {
  return new Command('attach')
    .description(a.text.attachDescription)
    .argument('[box]', BOX_REF_HELP)
    .option(
      '--session-name <name>',
      `tmux session name (default from config; built-in: ${a.spec.sessionName})`,
    )
    .option('--attach-in <mode>', ATTACH_IN_HELP)
    .option('-i, --inline', INLINE_HELP);
}

export function buildStartSubcommand(a: AgentCliSpec): Command {
  const { id, text } = a;
  return new Command('start')
    .description(text.startDescription)
    .argument('[box]', BOX_REF_HELP)
    .option(
      '--session-name <name>',
      `tmux session name (default from config; built-in: ${a.spec.sessionName})`,
    )
    .option(
      '--no-sync-config',
      `skip rsyncing the host's ${text.syncConfigLabel} into the box's volume before starting (faster; use existing in-box state)`,
    )
    .option('--attach-in <mode>', ATTACH_IN_HELP)
    .option('-i, --inline', INLINE_HELP)
    .option('-d, --no-attach', NO_ATTACH_HELP)
    .option('-c, --continue', text.startContinueHelp)
    .option('--resume <id>', text.startResumeHelp)
    .argument(
      `[${id}-args...]`,
      `extra args passed to ${id} when starting a new session; ignored if a session is already running. Place after \`--\`, e.g. \`agentbox ${id} start 1 -- ${text.argsExample}\``,
    );
}

export function buildLoginSubcommand(a: AgentCliSpec): Command {
  const cmd = new Command('login')
    .description(a.text.loginDescription)
    .argument('[args...]', a.text.loginArgsHelp);
  // Before `--interactive`, not after: an agent with its own login protocol
  // (claude's headless print-URL / `--code` pair) declares those flags first,
  // which is the order `--help` has always printed them in.
  a.runtime.loginCommand?.options?.(cmd);
  return cmd.option('--interactive', a.text.loginInteractiveHelp);
}
