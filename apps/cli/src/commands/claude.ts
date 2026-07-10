import { confirm, intro, log, outro, spinner } from '../lib/prompt.js';
import {
  findProjectRoot,
  loadEffectiveConfig,
  resolveDefaultCheckpoint,
  type AttachOpenIn,
  type UserConfig,
} from '@agentbox/config';
import { ensureProjectRepoOnControlPlane } from '../control-plane/ensure-repo-installed.js';
import {
  buildClaudeAttachArgv,
  buildClaudeLoginRunArgv,
  ClaudeSessionError,
  claudeSessionInfo,
  createBox,
  DEFAULT_BOX_IMAGE,
  DEFAULT_RELAY_PORT,
  detectEngine,
  ensureClaudeVolume,
  ensureImage,
  formatDetachNotice,
  hostBackupHasCredentials,
  hostClaudeBackupExpired,
  imageExists,
  inspectBox,
  rebuildPluginNativeDeps,
  recordLastAgent,
  runInteractiveClaudeLogin,
  seedSetupSkillIntoVolume,
  SHARED_CLAUDE_VOLUME,
  startBox,
  startClaudeSession,
  syncClaudeCredentials,
  unpauseBox,
  volumeClaudeCredentials,
  warmUpClaudeCredentials,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { Command } from 'commander';
import { resolveClaudeAuth, type ResolvedClaudeAuth } from '../auth.js';
import { reattachRef, resolveBoxOrExit, resolveBoxOrShift } from '../box-ref.js';
import { cloudSizingProviderOptions } from '../lib/cloud-sizing.js';
import { assertAgentCredsAvailable, MissingAgentCredsError } from '../lib/queue/assert-creds.js';
import { buildPromptArgs } from '../lib/queue/build-prompt-args.js';
import { maybeResyncWorkspace } from '../lib/resync-start.js';
import { buildResyncWarning } from '../lib/resync-warning.js';
import { agentResumeArgs } from '../agent-sessions.js';
import { applyClaudeSkipPermissions } from '../lib/skip-permissions.js';
import { parseMaxOption } from '../lib/queue/parse-max-option.js';
import { submitQueueJob } from '../lib/queue/submit.js';
import { captureOpenTerminalContext } from '../terminal/queue-open.js';
import { hostAwareOpenIn } from '../terminal/host.js';
import {
  ATTACH_IN_HELP,
  INLINE_HELP,
  NO_ATTACH_HELP,
  resolveAttachInOption,
} from './_attach-in.js';
import { cloudAgentAttach, cloudAgentStartDetached } from './_cloud-attach.js';
import { cloudAgentCreate } from './_cloud-agent-create.js';
import { runCarryGate, runQueuedCarryGate } from '../lib/carry-gate.js';
import { resolveGitCredsCarry } from '../lib/git-creds-gate.js';
import { FromBranchError, UseBranchError, resolveBranchSelection } from '../lib/from-branch.js';
import { providerForBox, providerForCreate } from '../provider/registry.js';
import {
  prepareTeleport,
  TeleportError,
  uploadTeleport,
  type ResolvedTeleport,
  type ResumeMode,
} from '../session-teleport/index.js';
import { resolvePlanTeleport } from '../session-teleport/plan.js';
import { clampSpinnerLine } from '../spinner-line.js';
import { makeProgressReporter } from '../lib/progress.js';
import { printLaunchRecap } from '../lib/launch-recap.js';
import { maybeShowInstallHint } from '../lib/install-hint.js';
import { openCommandLog } from '../lib/log-file.js';
import { resolveLimits } from '../limits.js';
import { maybePromptPortless } from '../portless-prompt.js';
import { maybeRunSetupWizard } from '../wizard.js';
import { evaluateBaseFreshness } from '../checkpoint-lookup.js';
import { runPrepare } from './prepare.js';
import { runWrappedAttach } from '../wrapped-pty/index.js';
import { pasteHostClipboardImage, uploadImageFileToBox } from '../lib/paste-image.js';
import { clipboardCaptureAvailable } from '../lib/host-clipboard.js';
import { handleLifecycleError } from './_errors.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loadPtyBackend } from '../pty/pty-backend.js';
import { claudeLoginBinding } from '../lib/agent-login-bindings.js';
import { runGuidedLogin } from '../lib/guided-login.js';
import {
  cleanupStaleSessions,
  findLiveSession,
  findPendingSession,
  readLoginState,
  selectLoginMode,
  writeLoginCode,
  writeLoginRequest,
  writeLoginState,
  type LoginState,
} from '../lib/claude-login-session.js';

/** Project an agent-create options struct down to what the queue worker needs. */
function pickCreateOpts(opts: ClaudeCreateOptions): import('@agentbox/relay').QueueJobCreateOpts {
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
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    memory: opts.memory,
    cpus: opts.cpus,
    pidsLimit: opts.pidsLimit,
    disk: opts.disk,
  };
}

/** Log how much the plugin-cache prune reclaimed, when it reclaimed anything. */
function logPrune(rebuild: { pruned: string[]; prunedBytes: number }): void {
  if (rebuild.prunedBytes <= 0) return;
  const mb = Math.round(rebuild.prunedBytes / 1024 / 1024);
  const n = rebuild.pruned.length;
  log.info(`pruned ${String(n)} stale plugin cache${n === 1 ? '' : 's'} (${String(mb)} MB freed)`);
}

/** Host-side URL for the relay (always loopback for the wrapper's SSE subscription). */
const RELAY_HOST_URL = `http://127.0.0.1:${String(DEFAULT_RELAY_PORT)}`;

/**
 * Replacement for the old `attachClaudeSession`: builds the docker tmux-
 * attach argv, hands it to the node-pty wrapper for the footer + prompt
 * channel, then exits with the inner pty's exit code. Falls back
 * transparently to plain spawnSync inside `runWrappedAttach` when stdio
 * isn't a TTY or node-pty isn't installed.
 */
export async function attachClaudeWrapped(
  box: BoxRecord,
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
): Promise<never> {
  const provider = await providerForBox(box);
  // Only wire Ctrl+V paste when this host can actually capture a clipboard image
  // (macOS, or a Linux desktop with xclip/wl-paste). Elsewhere Ctrl+V forwards
  // verbatim instead of being intercepted for a guaranteed-empty paste.
  const canPaste = await clipboardCaptureAvailable();
  const code = await runWrappedAttach({
    container: box.container,
    dockerArgv: buildClaudeAttachArgv(box.container, sessionName),
    relayBaseUrl: RELAY_HOST_URL,
    boxId: box.id,
    boxName: box.name,
    projectIndex: box.projectIndex,
    mode: 'claude',
    detachNotice: formatDetachNotice(reattach),
    onError,
    openIn,
    onPasteImage: canPaste ? () => pasteHostClipboardImage(provider, box) : undefined,
    onPasteImageFile: canPaste ? (p) => uploadImageFileToBox(provider, box, p) : undefined,
  });
  process.exit(code);
}

interface ClaudeCreateOptions {
  workspace: string;
  name?: string;
  hostSnapshot?: boolean;
  snapshot?: string; // --snapshot <ref>: start from this checkpoint
  image?: string;
  yes?: boolean;
  isolateClaudeConfig?: boolean;
  withPlaywright?: boolean;
  withEnv?: boolean;
  /** --dangerously-skip-permissions / --no-...: per-box override of claude.dangerouslySkipPermissions. */
  dangerouslySkipPermissions?: boolean;
  /** --carry-yes (or AGENTBOX_CARRY_YES=1): auto-approve the carry: block. */
  carryYes?: boolean;
  /** --carry <mode>: 'skip' disables carry for this run (also AGENTBOX_CARRY=skip). */
  carry?: 'skip' | 'ask';
  /** --with-credentials: copy a git credential into the box (git.pushMode=direct); cloud only.
   *  Token-vs-SSH is chosen ONLY at the interactive prompt (TTY required). */
  withCredentials?: boolean;
  vnc?: boolean; // commander: --no-vnc => false; default true (undefined treated as true)
  resync?: boolean; // commander: --no-resync => false; default true (config box.resyncOnStart)
  sharedDockerCache?: boolean;
  portless?: boolean; // commander: --portless / --no-portless => true / false / undefined
  sessionName?: string;
  memory?: string;
  cpus?: string;
  pidsLimit?: string;
  disk?: string;
  /** Sandbox backend: `docker` (default) or `daytona`. */
  provider?: string;
  /** --from-branch <ref>: base the box's per-box branch on this ref instead of HEAD. */
  fromBranch?: string;
  /** -b / --use-branch <name>: reuse an existing branch directly instead of forking agentbox/<name>. */
  useBranch?: string;
  /** -v / --verbose: bypass the spinner and stream raw provider output. */
  verbose?: boolean;
  /** Raw `--attach-in <mode>` value; validated by `parseAttachInOption`. */
  attachIn?: string;
  /** --inline: shortcut for `--attach-in same` (long-form only — `-i` is `--initial-prompt`). */
  inline?: boolean;
  /** Commander parses `-d, --no-attach` as `attach: false` (defaults true). */
  attach?: boolean;
  /**
   * `-i, --initial-prompt <text>`: seed the claude TUI with this user turn
   * and run in background mode (no attach). Jobs go through the host-wide
   * queue; `--max-running` overrides `queue.maxConcurrent` for this job.
   */
  initialPrompt?: string;
  /** Per-invocation override of `queue.maxConcurrent` (number string from commander). */
  maxRunning?: string;
  /** Per-invocation override of `queue.maxWorking` (number string from commander). */
  maxWorking?: string;
  /** `-c, --continue`: teleport and resume the most recent host claude session for this cwd. */
  continue?: boolean;
  /** `--resume <id>`: teleport and resume the specified host claude session by id. */
  resume?: string;
  /** `--plan <path>`: copy a host plan file into the box, start in plan mode, seed a resume prompt. */
  plan?: string;
}

function buildClaudeCliOverrides(opts: ClaudeCreateOptions): Partial<UserConfig> {
  const box: NonNullable<UserConfig['box']> = {};
  if (opts.hostSnapshot !== undefined) box.hostSnapshot = opts.hostSnapshot;
  if (opts.image !== undefined) box.image = opts.image;
  if (opts.withPlaywright === true) box.withPlaywright = true;
  if (opts.withEnv === true) box.withEnv = true;
  if (opts.vnc === false) box.vnc = false;
  if (opts.isolateClaudeConfig === true) box.isolateClaudeConfig = true;
  if (opts.sharedDockerCache === true) box.dockerCacheShared = true;
  const claude: NonNullable<UserConfig['claude']> = {};
  if (opts.sessionName !== undefined) claude.sessionName = opts.sessionName;
  if (opts.dangerouslySkipPermissions !== undefined)
    claude.dangerouslySkipPermissions = opts.dangerouslySkipPermissions;
  const out: Partial<UserConfig> = {};
  if (Object.keys(box).length > 0) out.box = box;
  if (Object.keys(claude).length > 0) out.claude = claude;
  if (opts.portless !== undefined) out.portless = { enabled: opts.portless };
  if (opts.withCredentials) out.git = { pushMode: 'direct' };
  const attachIn = resolveAttachInOption(opts);
  if (attachIn !== undefined) out.attach = { openIn: attachIn };
  return out;
}

/**
 * Run `claude auth login` in a throwaway container against the shared
 * claude-config volume, then extract the result to the host backup so every
 * future box (shared or isolate) is seeded from it. Returns the login
 * command's exit code.
 *
 * This is the legacy passthrough: it hands the terminal to claude's own TUI. See
 * {@link signInToClaude} for why that is no longer the default.
 */
async function runClaudeLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveClaudeLogin(
    buildClaudeLoginRunArgv({ volume: SHARED_CLAUDE_VOLUME, image, extraArgs }),
  );
  if (exitCode === 0) {
    // Absorb the fresh-token first-request 400 in a throwaway container before
    // any box uses these credentials (see warmUpClaudeCredentials). Runs before
    // syncClaudeCredentials so the host backup captures any token the warm-up
    // refreshes.
    const s = spinner();
    s.start('checking credentials');
    const warm = await warmUpClaudeCredentials(SHARED_CLAUDE_VOLUME, image, {
      onProgress: (line) => s.message(clampSpinnerLine(line)),
    });
    s.stop(warm.warmed ? 'credentials ready' : 'credentials check incomplete — continuing');
    await syncClaudeCredentials({ volume: SHARED_CLAUDE_VOLUME }, { image, isolate: false });
  }
  return exitCode;
}

/**
 * Sign in to Claude, the way every caller should: guided (drive the login
 * container under a pty, prompt for the code with our own clack prompt) so the
 * container's TUI never touches the user's terminal — it misbehaves on terminals
 * whose keyboard protocol it mishandles (kitty's CSI-u).
 *
 * Falls back to the passthrough when the optional node-pty prebuild is missing,
 * or when the caller forces it. Returns rather than exiting, so the first-run
 * offers can warn and continue.
 */
async function signInToClaude(
  image: string,
  extraArgs: string[],
  opts: { passthrough?: boolean } = {},
): Promise<{ ok: boolean; error?: string; cancelled?: boolean }> {
  const usePassthrough = opts.passthrough === true || !(await loadPtyBackend());
  if (usePassthrough) {
    const exitCode = await runClaudeLoginContainer(image, extraArgs);
    return exitCode === 0
      ? { ok: true }
      : { ok: false, error: `\`claude auth login\` exited with code ${String(exitCode)}` };
  }
  const res = await runGuidedLogin('claude', (writeLog) =>
    claudeLoginBinding({ image, extraArgs, writeLog }),
  );
  return { ok: res.ok, error: res.error, cancelled: res.cancelled };
}

/**
 * First-run sign-in offer, shown before box creation / the setup wizard. When
 * no credentials are available yet, prompts the user and (on confirm) runs
 * `claude auth login` in a throwaway container — the result seeds every future
 * box via the host backup. Silent no-op when credentials already exist, in
 * non-interactive runs, or when the user provided auth via host env.
 */
async function maybeRunClaudeLogin(args: {
  image: string;
  authSource: ResolvedClaudeAuth['source'];
  yes: boolean;
  /** Host workspace path — seeds the project-scoped `/workspace` alias into
   *  the volume's `_claude.json` before the login container runs. */
  hostWorkspace: string;
}): Promise<void> {
  // Skip when: non-interactive / --yes; or the user explicitly provided auth
  // via host env (respect an intentional ANTHROPIC_API_KEY).
  if (!process.stdin.isTTY || args.yes) return;
  if (args.authSource === 'host-env') return;

  // Docker boots every box from the shared claude-config volume's live
  // `.credentials.json`; the host backup is only a mirror that diverges when an
  // in-box refresh fails (claude blanks the volume's refreshToken, and the
  // create-time extract then skips it, so the backup keeps a stale token). So
  // decide off the *volume*, not the backup:
  //  - usable refresh token present -> trust the in-box refresh, no prompt
  //    (a merely-expired access token renews itself; don't nag);
  //  - file present but refresh token blanked -> the login is dead (the seed
  //    only restores the same stale backup), so offer a fresh sign-in;
  //  - no file yet -> the box seeds from the host backup, so only offer
  //    sign-in when there is nothing to seed from either.
  // The probe needs the image locally; skip it (fall back to the backup check)
  // when it isn't, so a first-ever run doesn't trigger an implicit pull here.
  const vol = (await imageExists(args.image))
    ? await volumeClaudeCredentials(SHARED_CLAUDE_VOLUME, args.image)
    : { present: false, hasRefreshToken: false };
  if (vol.hasRefreshToken) return;
  const blanked = vol.present && !vol.hasRefreshToken;
  if (!vol.present && (await hostBackupHasCredentials())) return;

  const message = blanked
    ? 'Your saved Claude login looks expired. Sign in again? (saved and reused by every box)'
    : args.authSource === 'auth-file'
      ? "You're on a legacy API token (shows as 'Claude API'). Sign in with your Claude subscription instead?"
      : 'Sign in with your Claude subscription? (saved and reused by every box)';
  const answer = await confirm({ message, initialValue: true });
  if (!answer) {
    log.info('Skipped sign-in — claude will prompt you to /login inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  // Seed the shared claude-config volume from the host's ~/.claude *before*
  // the login container runs, so `claude auth login` writes its oauthAccount
  // on top of the host config (trust, installMethod, project alias) rather
  // than into an empty volume. ensureClaudeVolume is write-once for
  // _claude.json, so the later createBox sync can't clobber the login's work.
  s.message('preparing claude config');
  await ensureClaudeVolume(
    { volume: SHARED_CLAUDE_VOLUME },
    { syncFromHost: true, image: args.image, hostWorkspace: args.hostWorkspace },
  );
  s.stop('image ready');

  const res = await signInToClaude(args.image, ['--claudeai']);
  if (!res.ok) {
    log.warn('Claude login did not complete; continuing — run `agentbox claude login` to retry.');
    return;
  }
  log.success('Signed in with your Claude subscription — saved for future boxes.');
}

/**
 * Cloud counterpart of {@link maybeRunClaudeLogin}: offered before creating a
 * CLOUD box. Cloud has no shared volume to persist an in-box login, so without
 * a host credential the box boots unauthenticated. Capturing the login to
 * `~/.agentbox/claude-credentials.json` (via the same throwaway-container login
 * + `syncClaudeCredentials`) lets the cloud push seed it into this box and every
 * future one. Also re-offers when the saved token is *expired* — the in-box
 * refresh has proven unreliable on cloud. Skips on non-TTY / --yes / host env.
 */
async function maybeRunCloudClaudeLogin(args: {
  image: string;
  authSource: ResolvedClaudeAuth['source'];
  yes: boolean;
  hostWorkspace: string;
}): Promise<void> {
  if (!process.stdin.isTTY || args.yes) return;
  if (args.authSource === 'host-env') return;
  const hasCreds = await hostBackupHasCredentials();
  const expired = hasCreds && (await hostClaudeBackupExpired());
  if (hasCreds && !expired) return;

  const message = expired
    ? 'Your saved Claude login looks expired. Sign in again? (saved and reused by every box)'
    : 'Sign in with your Claude subscription? (saved and reused by every box)';
  const answer = await confirm({ message, initialValue: true });
  if (!answer) {
    log.info('Skipped sign-in — claude will prompt you to /login inside the box.');
    return;
  }

  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(args.image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  s.message('preparing claude config');
  await ensureClaudeVolume(
    { volume: SHARED_CLAUDE_VOLUME },
    { syncFromHost: true, image: args.image, hostWorkspace: args.hostWorkspace },
  );
  s.stop('image ready');

  const res = await signInToClaude(args.image, ['--claudeai']);
  if (!res.ok) {
    log.warn('Claude login did not complete; continuing — run `agentbox claude login` to retry.');
    return;
  }
  log.success('Signed in with your Claude subscription — saved for future boxes.');
}

export const claudeCommand = new Command('claude')
  .description('Create a sandboxed box and launch Claude Code in a detachable tmux session')
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
    '--with-credentials',
    "copy a git credential INTO the box so it can push with your PC off. You'll be asked at an interactive prompt to choose 'token' (HTTPS, unsigned commits, smallest exposure) or your 'ssh' private key (signs commits, riskiest). DANGEROUS: the credential lives in the box and its snapshots. Requires a real terminal (no non-interactive / CI path). Cloud only. Sets git.pushMode=direct.",
  )
  .option(
    '--isolate-claude-config',
    'use a per-box ~/.claude volume instead of the shared agentbox-claude-config',
  )
  .option('--with-playwright', 'also install @playwright/cli@latest globally inside the box')
  .option(
    '--dangerously-skip-permissions',
    'launch claude with --dangerously-skip-permissions (auto-accept tool use); on by default since boxes are isolated',
  )
  .option(
    '--no-dangerously-skip-permissions',
    'do not pass --dangerously-skip-permissions to claude in this box',
  )
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
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
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
    '-v, --verbose',
    'bypass the spinner and stream raw provider output (docker build / Daytona snapshot create) to stderr. The same content always lands in ~/.agentbox/logs/claude.log.',
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('--inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-i, --initial-prompt <text>',
    "seed the claude session with this initial user turn and run in background (no attach). Jobs go through the host-wide queue (queue.maxConcurrent). NOTE: this is NOT claude's own `-p` headless print mode — for that, pass `-- -p ...`.",
  )
  .option(
    '--max-running <n>',
    'per-invocation override of queue.maxConcurrent; only honored when `-i` is set',
  )
  .option(
    '--max-working <n>',
    'per-invocation override of queue.maxWorking; only honored when `-i` is set',
  )
  .option(
    '-c, --continue',
    'teleport the most recent host Claude Code session for this cwd into the box and resume from it',
  )
  .option(
    '--resume <id>',
    'teleport the specified host Claude Code session id into the box and resume from it',
  )
  .option(
    '--plan <path>',
    'copy a Claude Code plan file (e.g. ~/.claude/plans/<slug>.md) into the box, launch claude with --permission-mode plan, and seed a "resume the plan" prompt',
  )
  .argument(
    '[claude-args...]',
    'extra args passed to claude inside the box; place after `--`, e.g. `agentbox claude -- --model sonnet`',
  )
  .action(async (claudeArgs: string[], opts: ClaudeCreateOptions) => {
    const cmdLog = openCommandLog('claude');
    intro('Starting Claude in a box...');

    // -c / --continue / --resume <id>: handled by agentbox (the teleport runs
    // after box creation, below) and forwarded to the in-box claude as the
    // canonical `--resume <id>` tuple. The in-box claude never sees `-c`.
    let resumeMode: ResumeMode | null = null;
    if (opts.continue === true && opts.resume) {
      log.error('only one of -c / --continue / --resume can be passed');
      cmdLog.close();
      process.exit(2);
    }
    if (opts.continue === true) resumeMode = { kind: 'continue' };
    else if (opts.resume) resumeMode = { kind: 'resume', id: opts.resume };
    if (resumeMode && opts.initialPrompt && opts.initialPrompt.length > 0) {
      log.error(
        '-i / --initial-prompt cannot be combined with -c / --resume (seeding a new turn into a resumed session is not supported).',
      );
      cmdLog.close();
      process.exit(2);
    }
    // --plan seeds an interactive "resume the plan" turn, which is incompatible
    // with -i's background-queue mode (the same reason resume + -i is rejected).
    if (opts.plan && opts.initialPrompt && opts.initialPrompt.length > 0) {
      log.error(
        '--plan cannot be combined with -i / --initial-prompt (--plan already seeds an interactive "resume the plan" turn).',
      );
      cmdLog.close();
      process.exit(2);
    }
    // Pre-flight: resolve the host session BEFORE any box work so a missing
    // session id fails fast (the user doesn't pay for a doomed box).
    let resumePrepared: ResolvedTeleport | null = null;
    if (resumeMode) {
      try {
        resumePrepared = await prepareTeleport({
          agent: 'claude',
          hostCwd: opts.workspace,
          mode: resumeMode,
          log: (line) => cmdLog.write(line),
        });
      } catch (err) {
        if (err instanceof TeleportError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }
    // Pre-flight the plan file too: a bad --plan path should fail before any box
    // work. forwardArgs is empty; the plan drives prompt + permission-mode below.
    let planPrepared: ResolvedTeleport | null = null;
    if (opts.plan) {
      try {
        planPrepared = await resolvePlanTeleport({
          planPath: opts.plan,
          hostCwd: opts.workspace,
          log: (line) => cmdLog.write(line),
        });
      } catch (err) {
        if (err instanceof TeleportError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }

    const cfg = await loadEffectiveConfig(opts.workspace, {
      cliOverrides: buildClaudeCliOverrides(opts),
    });
    const projectRoot = (await findProjectRoot(opts.workspace)).root;
    // Resolve provider once. The --provider flag wins, then box.provider config,
    // then default 'docker'. The Docker-only fast path below skips entirely on
    // cloud — we delegate to the cloud-agent-create helper after running the
    // (provider-agnostic) setup wizard.
    const providerName = opts.provider ?? cfg.effective.box.provider ?? 'docker';
    const isCloud = providerName !== 'docker';

    if (cfg.effective.git.pushMode === 'direct' && !isCloud) {
      log.error(
        'git.pushMode=direct / --with-credentials is not applicable to docker boxes (they run on your host and bind-mount the host .git). Use a cloud provider (e.g. --provider hetzner|e2b|vercel|daytona).',
      );
      cmdLog.close();
      process.exit(1);
    }

    // When a control plane is configured, make sure this project's repo is
    // authorized on its GitHub App so the box can lease push tokens.
    await ensureProjectRepoOnControlPlane({
      controlPlaneUrl: cfg.effective.relay.controlPlaneUrl,
      gitPushMode: cfg.effective.git.pushMode,
      projectRoot,
      yes: !!opts.yes,
    });

    // -i / --initial-prompt: background mode. Write a queue manifest and exit;
    // the relay's queue loop spawns the worker as a slot frees. Works on every
    // provider — the worker creates the box and pre-starts the seeded session
    // (docker bakes the prompt into `tmux new-session`; cloud pre-starts a
    // detached tmux session via `buildAttach({ detached: true })`).
    if (opts.initialPrompt && opts.initialPrompt.length > 0) {
      try {
        await assertAgentCredsAvailable({
          agent: 'claude-code',
          image: cfg.effective.box.image,
          providerName,
        });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
      const maxRunningOverride = parseMaxOption('--max-running', opts.maxRunning);
      const maxWorkingOverride = parseMaxOption('--max-working', opts.maxWorking);
      // Carry gate runs here on the host (same gate as the foreground path) so
      // the user approves the host-secrets copy while submitting; the approved
      // entries ride the queue job and the worker applies them at create time.
      const carryForQueue = await resolveGitCredsCarry({
        pushMode: cfg.effective.git.pushMode,
        projectRoot,
        existing: await runQueuedCarryGate({
          projectRoot,
          opts,
          onLog: (line) => cmdLog.write(line),
          onClose: () => cmdLog.close(),
        }),
        onLog: (line) => cmdLog.write(line),
        onClose: () => cmdLog.close(),
      });
      const result = await submitQueueJob({
        agent: 'claude-code',
        boxName: opts.name ?? '',
        providerName,
        prompt: opts.initialPrompt,
        agentArgs: claudeArgs,
        createOpts: { ...pickCreateOpts(opts), carry: carryForQueue },
        maxRunningOverride,
        maxWorkingOverride,
        openTerminal: captureOpenTerminalContext(cfg.effective.queue.openIn),
      });
      outro(
        `job ${result.job.id} queued (${String(result.runningCount)}/${String(result.maxConcurrent)} running); log: ${result.job.logPath}`,
      );
      cmdLog.close();
      return;
    }
    const providerDefault = resolveDefaultCheckpoint(cfg.effective, providerName);
    const checkpointRef =
      opts.snapshot && opts.snapshot.length > 0
        ? opts.snapshot
        : providerDefault.length > 0
          ? providerDefault
          : undefined;

    // Resolve auth from host env or the legacy ~/.agentbox/auth.json
    // setup-token (the dormant CI fallback).
    const resolved = await resolveClaudeAuth(process.env);

    // Non-interactive (orchestrator pipe, CI): no TTY to attach or complete an
    // in-box /login, so fail fast with the same actionable message the prompt
    // would give instead of booting a box whose agent then silently sits on its
    // /login screen. `-y` in a real TTY is exempt — that's the documented "boot
    // and /login inside the box" escape hatch (the user is present). Host-env
    // auth is exempt too (its presence is the user's explicit choice). The
    // expiry half of the check is cloud-only — docker boxes refresh in-box.
    if (!process.stdin.isTTY && resolved.source !== 'host-env') {
      try {
        await assertAgentCredsAvailable({
          agent: 'claude-code',
          image: cfg.effective.box.image,
          providerName,
        });
      } catch (err) {
        if (err instanceof MissingAgentCredsError) {
          log.error(err.message);
          cmdLog.close();
          process.exit(2);
        }
        throw err;
      }
    }

    // First-run sign-in offer. Docker seeds every box from the host backup;
    // cloud captures the login to the same backup so the per-box push seeds it
    // (and re-offers on an expired token). Both run the throwaway-container
    // login — docker is always available.
    if (!isCloud) {
      await maybeRunClaudeLogin({
        image: cfg.effective.box.image,
        authSource: resolved.source,
        yes: !!opts.yes,
        hostWorkspace: opts.workspace,
      });
    } else {
      // The login runs in a throwaway DOCKER container to capture the token to
      // ~/.agentbox — so it needs a docker image, not `box.image`, which on the
      // cloud path can be a cloud snapshot ref (e.g. `snap_…`) that `docker
      // build` rejects. The default box image carries the agent CLIs.
      await maybeRunCloudClaudeLogin({
        image: DEFAULT_BOX_IMAGE,
        authSource: resolved.source,
        yes: !!opts.yes,
        hostWorkspace: opts.workspace,
      });
    }

    // Portless is Docker Desktop-only — skip on cloud.
    const portlessEnabled = isCloud
      ? undefined
      : await maybePromptPortless({
          engine: await detectEngine(),
          enabled: cfg.effective.portless.enabled,
          yes: !!opts.yes,
          cwd: opts.workspace,
        });

    // Carry gate (agentbox.yaml's `carry:` block): resolve + ask BEFORE the
    // wizard so the user sees the host-secrets prompt while still in the
    // pre-create phase. Cancel aborts; skip proceeds with no carry payload.
    let carryEntries: import('@agentbox/core').ResolvedCarryEntry[] = [];
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
      log.error(err instanceof Error ? err.message : String(err));
      cmdLog.close();
      process.exit(1);
    }

    // git.pushMode=direct (--with-credentials): copy the user's git credentials
    // into the box (gated), riding the same carry apply path.
    carryEntries = await resolveGitCredsCarry({
      pushMode: cfg.effective.git.pushMode,
      projectRoot,
      existing: carryEntries,
      onLog: (line) => cmdLog.write(line),
      onClose: () => cmdLog.close(),
    });

    // First-run wizard: when no agentbox.yaml exists, offer to inject an
    // initial user-message so claude reads /agentbox-setup and writes one.
    // Skipped when starting from a checkpoint (it already carries the config).
    //
    // Base freshness: cloud providers store a fingerprint of the baked
    // runtime; if the local install no longer matches, the wizard offers to
    // rebuild before creating. Docker self-heals via `ensureImage`, so its
    // baseStatus is always `fresh` and the wizard is a no-op here.
    const baseStatus = await evaluateBaseFreshness(
      providerName,
      cfg.effective.box.claudeInstall,
    );
    const wiz = await maybeRunSetupWizard({
      workspace: opts.workspace,
      yes: !!opts.yes,
      command: 'claude',
      checkpointRef,
      checkpointFromDefault: !(opts.snapshot && opts.snapshot.length > 0),
      provider: providerName,
      withEnv: cfg.effective.box.withEnv,
      baseStatus,
    });
    // Stale base: user opted in to rebuilding it. Re-bakes the snapshot /
    // template and refreshes its stored fingerprint, so the subsequent box
    // boots from the fresh base. Runs *before* checkpoint discard so a
    // failure aborts cleanly without leaving a half-created box.
    if (wiz.rebuildBase) {
      log.warn(`${providerName} base image is outdated; rebuilding before create…`);
      await runPrepare(providerName, {
        force: true,
        cwd: opts.workspace,
        suppressStatus: true,
      });
    }
    // The wizard may discard a stale/dead default checkpoint (recreate, or a
    // non-interactive run): boot from the current base instead of the old
    // artifact. An explicit `--snapshot` is never discarded.
    const effectiveCheckpointRef = wiz.discardCheckpoint ? undefined : checkpointRef;
    let effectiveClaudeArgs = claudeArgs;
    // --plan: enter plan mode and seed a "resume the plan" turn. Adding
    // --permission-mode before applyClaudeSkipPermissions makes the latter treat
    // it as a conflict and skip --dangerously-skip-permissions (plan mode wins).
    if (planPrepared) {
      const hasPermissionMode = effectiveClaudeArgs.some(
        (a) => a === '--permission-mode' || a.startsWith('--permission-mode='),
      );
      if (!hasPermissionMode) {
        effectiveClaudeArgs = [...effectiveClaudeArgs, '--permission-mode', 'plan'];
      }
      const planPrompt = `Resume the plan at ~/.claude/plans/${planPrepared.sessionId}`;
      effectiveClaudeArgs = buildPromptArgs('claude-code', planPrompt, effectiveClaudeArgs);
    } else if (wiz.action === 'launch-with-prompt' && wiz.initialPrompt) {
      effectiveClaudeArgs = buildPromptArgs('claude-code', wiz.initialPrompt, claudeArgs);
    }
    // Auto-accept tool use by default (boxes are isolated). One injection here
    // flows to both the docker session start and the cloud attach below.
    effectiveClaudeArgs = applyClaudeSkipPermissions(effectiveClaudeArgs, cfg.effective);

    // Validate branch selection before any provider work so a typo doesn't
    // leave a half-created box.
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

    if (isCloud) {
      const provider = await providerForCreate({ flag: opts.provider, config: cfg.effective });
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set.
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      await cloudAgentCreate({
        provider,
        request: {
          workspacePath: opts.workspace,
          name: opts.name,
          checkpointRef: effectiveCheckpointRef,
          image: cfg.effective.box.image,
          withPlaywright,
          withEnv: cfg.effective.box.withEnv,
          envFilesToImport: wiz.envFilesToImport,
          carry: carryEntries,
          vnc: { enabled: cfg.effective.box.vnc },
          limits: resolveLimits(cfg.effective.box, opts),
          fromBranch,
          useBranch,
          resyncOnStart: opts.resync,
          projectRoot,
          // Control-plane topology + git push routing — mirror `agentbox create`
          // so cloud boxes from the agent commands honor the same config.
          controlPlaneUrl: cfg.effective.relay.controlPlaneUrl,
          gitPushMode: cfg.effective.git.pushMode,
          // Per-provider session-lifetime (e2b/vercel timeout) so the keepalive
          // seeds correctly; mirrors `agentbox create`.
          providerOptions: cloudSizingProviderOptions(provider.name, cfg.effective),
        },
        binary: 'claude',
        hasSeedPrompt:
          Boolean(planPrepared) ||
          (wiz.action === 'launch-with-prompt' && Boolean(wiz.initialPrompt)) ||
          Boolean(resumePrepared),
        sessionName: cfg.effective.claude.sessionName,
        mode: 'claude',
        extraArgs: effectiveClaudeArgs,
        verbose: opts.verbose === true,
        openIn: hostAwareOpenIn(cfg),
        attach: opts.attach !== false,
        beforeStart:
          resumePrepared || planPrepared
            ? async (box) => {
                try {
                  if (resumePrepared) {
                    await uploadTeleport({
                      box,
                      provider,
                      resolved: resumePrepared,
                      log: (line) => cmdLog.write(line),
                    });
                  }
                  if (planPrepared) {
                    await uploadTeleport({
                      box,
                      provider,
                      resolved: planPrepared,
                      log: (line) => cmdLog.write(line),
                    });
                  }
                  return { agentArgsPrefix: resumePrepared?.forwardArgs ?? [] };
                } catch (err) {
                  if (err instanceof TeleportError) {
                    log.error(err.message);
                    cmdLog.close();
                    process.exit(2);
                  }
                  throw err;
                }
              }
            : undefined,
      });
      return;
    }

    // host-snapshot default off: with the overlay retired, the snapshot is
    // only the tar-pipe source for the no-git case, and skipped entirely for
    // git-detected workspaces. Explicit flag/config still wins.
    const useSnapshot =
      opts.hostSnapshot === false
        ? false
        : opts.hostSnapshot === true
          ? true
          : (cfg.effective.box.hostSnapshot ?? false);
    const sessionName = cfg.effective.claude.sessionName;

    const s = makeProgressReporter(opts.verbose === true);
    s.start('creating box');
    let containerName = '';
    try {
      // browser.default = 'playwright' | 'both' implies installing playwright
      // even if box.withPlaywright wasn't explicitly set in any layer.
      const withPlaywright =
        cfg.effective.box.withPlaywright || cfg.effective.browser.default !== 'agent-browser';
      const result = await createBox({
        workspacePath: opts.workspace,
        name: opts.name,
        useSnapshot,
        checkpointRef: effectiveCheckpointRef,
        fromBranch,
        useBranch,
        resyncOnStart: opts.resync,
        image: cfg.effective.box.image,
        claudeConfig: { isolate: cfg.effective.box.isolateClaudeConfig },
        claudeEnv: resolved.env,
        withPlaywright,
        withEnv: cfg.effective.box.withEnv,
        envFilesToImport: wiz.envFilesToImport,
        carry: carryEntries,
        vnc: { enabled: cfg.effective.box.vnc },
        docker: { sharedCache: cfg.effective.box.dockerCacheShared },
        portless: portlessEnabled,
        portlessStateDir: cfg.effective.portless.stateDir || undefined,
        limits: resolveLimits(cfg.effective.box, opts),
        projectRoot,
        onLog: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });
      containerName = result.record.container;

      // Plugin native deps: the sync excludes `node_modules` (host darwin
      // binaries don't run on linux/amd64). First claude session in a fresh
      // box pays the npm-install cost for each plugin that ships a
      // package.json; subsequent attaches see node_modules already present
      // and exit immediately. Keep the same spinner alive — every phase
      // overwrites the one line instead of leaving a scroll of `●`/`◇` rows.
      s.message('checking plugin native deps');
      cmdLog.write('checking plugin native deps');
      const rebuild = await rebuildPluginNativeDeps(result.record.container, {
        volume: result.record.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
        onProgress: (line) => {
          s.message(line);
          cmdLog.write(line);
        },
      });

      if (resumePrepared) {
        s.message('uploading claude session into box');
        cmdLog.write('uploading claude session into box');
        try {
          const provider = await providerForBox(result.record);
          await uploadTeleport({
            box: result.record,
            provider,
            resolved: resumePrepared,
            log: (line) => {
              s.message(clampSpinnerLine(line));
              cmdLog.write(line);
            },
          });
          effectiveClaudeArgs = [...resumePrepared.forwardArgs, ...effectiveClaudeArgs];
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

      if (planPrepared) {
        s.message('uploading plan into box');
        cmdLog.write('uploading plan into box');
        try {
          const provider = await providerForBox(result.record);
          await uploadTeleport({
            box: result.record,
            provider,
            resolved: planPrepared,
            log: (line) => {
              s.message(clampSpinnerLine(line));
              cmdLog.write(line);
            },
          });
        } catch (err) {
          if (err instanceof TeleportError) {
            s.stop('plan upload failed');
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

      // On-create resync conflicts (checkpoint-restore path): inject the
      // warning as the opening turn when no other seed is set, else surface it
      // on stderr (a plan/wizard/resume seed already owns the first turn).
      const createResyncWarning = result.resync ? buildResyncWarning(result.resync) : null;
      let pendingCreateResyncWarn: string | null = null;
      if (createResyncWarning) {
        const hasSeed =
          Boolean(planPrepared) ||
          (wiz.action === 'launch-with-prompt' && Boolean(wiz.initialPrompt)) ||
          Boolean(resumePrepared);
        if (hasSeed) pendingCreateResyncWarn = createResyncWarning;
        else
          effectiveClaudeArgs = buildPromptArgs(
            'claude-code',
            createResyncWarning,
            effectiveClaudeArgs,
          );
      }

      s.message('starting claude session');
      await startClaudeSession({
        container: result.record.container,
        claudeArgs: effectiveClaudeArgs,
        sessionName,
        boxName: result.record.name,
      });
      // Remember this box was launched as claude so `agentbox recover` relaunches
      // the right agent. Best-effort — never block the launch.
      await recordLastAgent(result.record.id, 'claude').catch(() => {});
      if (pendingCreateResyncWarn) log.warn(pendingCreateResyncWarn);

      const nSuffix =
        typeof result.record.projectIndex === 'number'
          ? `  ·  n ${String(result.record.projectIndex)}`
          : '';
      s.stop(`box ready${nSuffix}`);
      logPrune(rebuild);
      for (const f of rebuild.failed) {
        log.warn(
          `plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`,
        );
      }
      maybeShowInstallHint();

      await printLaunchRecap({
        record: result.record,
        mode: 'claude',
        reattach: reattachRef(result.record),
        workspacePath: opts.workspace,
        fromBranch,
        useBranch,
        checkpointRef: effectiveCheckpointRef,
        attaching: opts.attach !== false,
      });
      if (opts.attach === false) {
        return;
      }
      await attachClaudeWrapped(
        result.record,
        sessionName,
        reattachRef(result.record),
        (m) => cmdLog.write(m),
        hostAwareOpenIn(cfg),
      );
    } catch (err) {
      s.stop('failed');
      cmdLog.write(`FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
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
  });

interface ClaudeStartOptions {
  sessionName?: string;
  /** Inherited from the parent `claude` command via optsWithGlobals. */
  dangerouslySkipPermissions?: boolean;
  resync?: boolean; // commander: --no-resync => false; default true (config box.resyncOnStart)
  syncConfig?: boolean; // commander: --no-sync-config => false; default true
  attachIn?: string; // raw `--attach-in <mode>` value, validated below.
  inline?: boolean; // -i / --inline: shortcut for --attach-in same.
  attach?: boolean; // commander: --no-attach => false; default true.
  continue?: boolean; // -c / --continue: teleport newest session for cwd.
  resume?: string; // --resume <id>: teleport specific session.
  // Set by the `attach` subcommand: when the box was down and is being brought
  // back up, resume the in-box session (`--continue`) instead of starting fresh,
  // so attaching after a stop / cloud idle-timeout looks seamless. NOT set by the
  // bare `claude` / `claude start` command, which stays fresh.
  attachResume?: boolean;
}

// Shared by `claude start` and `claude attach`: if a session is already
// running, just attach; otherwise auto-unpause/start the box, (optionally)
// resync ~/.claude, rebuild plugin native deps, launch claude, then attach.
async function startOrAttachClaude(
  box: BoxRecord,
  claudeArgs: string[],
  opts: ClaudeStartOptions,
  resumePrepared?: ResolvedTeleport | null,
): Promise<void> {
  const attachIn = resolveAttachInOption(opts);
  const cliOverrides: Partial<UserConfig> = {};
  if (opts.sessionName) cliOverrides.claude = { sessionName: opts.sessionName };
  if (opts.dangerouslySkipPermissions !== undefined) {
    cliOverrides.claude = {
      ...cliOverrides.claude,
      dangerouslySkipPermissions: opts.dangerouslySkipPermissions,
    };
  }
  if (attachIn !== undefined) cliOverrides.attach = { openIn: attachIn };
  if (opts.resync !== undefined) cliOverrides.box = { resyncOnStart: opts.resync };
  const cfg = await loadEffectiveConfig(box.workspacePath, { cliOverrides });
  const sessionName = cfg.effective.claude.sessionName;
  const openIn = hostAwareOpenIn(cfg);
  const wantAttach = opts.attach !== false;
  // Read-only — used to gate the first-run login offer (respect an intentional
  // host ANTHROPIC_API_KEY). The box already exists, so `resolved.env` is not
  // forwarded here.
  const resolved = await resolveClaudeAuth(process.env);

  // Auto-unpause/start. Mirrors `agentbox shell` / `agentbox code`.
  // `startBox` relaunches ctl/vnc/dockerd
  // because those processes die with the container.
  const insp = await inspectBox(box.id);
  if (insp.state === 'missing') {
    throw new Error(`box ${box.name} has no container; was it destroyed?`);
  }
  // Record this attach/launch as a claude session so `agentbox recover` knows
  // which agent to bring back. Best-effort.
  await recordLastAgent(box.id, 'claude').catch(() => {});

  // If a tmux session already exists, just attach — no resync, no plugin
  // rebuild, ignore any post-`--` args (they only apply to a fresh claude).
  // A login can't be inserted into a live session; an unauthenticated one
  // shows claude's own in-TUI `/login` on attach.
  const existing = await claudeSessionInfo(box.container, sessionName);
  if (existing.running) {
    if (resumePrepared) {
      throw new Error(
        `cannot resume into ${box.name}: a Claude session is already running. Detach and kill the session first (Control+a then :kill-session), or use \`agentbox claude attach\` to reattach to the live one.`,
      );
    }
    if (!wantAttach) {
      outro(
        `session "${sessionName}" already running — attach with: agentbox claude attach ${reattachRef(box)}`,
      );
      return;
    }
    outro(`session "${sessionName}" already running — attaching (Control+a d to detach)`);
    await attachClaudeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
    return;
  }

  // First-run sign-in offer — before any box prep, so the user signs in up
  // front. No-op when credentials already exist or this isn't interactive.
  await maybeRunClaudeLogin({
    image: box.image,
    authSource: resolved.source,
    yes: false,
    hostWorkspace: box.workspacePath,
  });

  // One spinner for the whole prepare→attach sequence: every phase overwrites
  // the single line instead of leaving a scroll of `●`/`◇` rows.
  const s = spinner();
  s.start('preparing box');

  // Auto-unpause/start. `startBox` relaunches
  // ctl/vnc/dockerd because those processes die with the container.
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
  // live agent session whose files we must not mutate underneath it. We're
  // past the `existing.running` early-return, so this agent isn't live.
  const resyncWarning = await maybeResyncWorkspace({
    box,
    enabled: cfg.effective.box.resyncOnStart && wasDown,
    projectRoot: cfg.projectRoot,
    spinner: s,
  });

  // Re-sync the host's ~/.claude into the box volume so any updates the user
  // made on the host (new MCP servers, refreshed OAuth state in _claude.json,
  // …) reach the in-box claude. This runs for `claude start` (default; opt out
  // with --no-sync-config) — NOT for `claude attach`, which always passes
  // syncConfig: false: a plain reattach must never clobber the in-box claude's
  // accumulated _claude.json (prompt history) with the host copy.
  const syncConfig = opts.syncConfig !== false;
  if (syncConfig) {
    s.message('syncing ~/.claude into box volume');
    // Use the box's recorded volume so isolated boxes hit their own
    // agentbox-claude-config-<id>, not the shared one.
    const volume = box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME;
    await ensureClaudeVolume(
      { volume },
      {
        syncFromHost: true,
        image: box.image,
        hostWorkspace: box.workspacePath,
      },
    );
  }

  // Box-only: ensure /agentbox-setup is in the volume (image-seeded, never
  // on the host). Re-copied every run so an image upgrade propagates.
  const claudeVolume = box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME;
  await seedSetupSkillIntoVolume(claudeVolume, box.image);

  // Mirror the in-box OAuth credentials with the host backup. Runs regardless
  // of --no-sync-config (this is not the host ~/.claude rsync) — it keeps the
  // backup fresh as the in-box claude rotates its token, and seeds an isolate
  // box's volume from an up-front `maybeRunClaudeLogin`.
  await syncClaudeCredentials(
    { volume: claudeVolume },
    { image: box.image, isolate: claudeVolume !== SHARED_CLAUDE_VOLUME },
  );

  // Plugin native deps: idempotent — gated by a per-plugin marker. No-op
  // on subsequent starts unless a new plugin was synced just now.
  s.message('checking plugin native deps');
  const rebuild = await rebuildPluginNativeDeps(box.container, {
    volume: box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
    onProgress: (line) => s.message(clampSpinnerLine(line)),
  });

  let effectiveArgs = applyClaudeSkipPermissions(claudeArgs, cfg.effective);
  // Attach path on a box that just came back up: resume the box's recorded
  // session (exact id, captured by the in-box hooks) rather than starting fresh.
  // Only when the user gave no args of their own and isn't teleporting a host
  // session, and only if the box actually has a resumable session.
  let attachResumed = false;
  if (opts.attachResume && claudeArgs.length === 0 && !resumePrepared) {
    const provider = await providerForBox(box);
    const resume = await agentResumeArgs(provider, box, 'claude');
    if (resume) {
      effectiveArgs = [...effectiveArgs, ...resume];
      attachResumed = true;
    }
  }
  if (resumePrepared) {
    s.message('uploading claude session into box');
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
  // session (teleport `--resume`, or an attach-resume into the in-box session)
  // rides resume flags with no clean first user turn, so surface the warning on
  // stderr after the spinner stops instead — injecting a seed prompt would
  // collide with `--resume`.
  if (resyncWarning && !resumePrepared && !attachResumed) {
    effectiveArgs = buildPromptArgs('claude-code', resyncWarning, effectiveArgs);
  }

  s.message('starting claude session');
  await startClaudeSession({
    container: box.container,
    claudeArgs: effectiveArgs,
    sessionName,
    boxName: box.name,
  });

  s.stop(`box ${box.container} ready`);
  if (resyncWarning && (resumePrepared || attachResumed)) log.warn(resyncWarning);
  logPrune(rebuild);
  for (const f of rebuild.failed) {
    log.warn(
      `plugin install failed for ${f.dir}; claude may still load it. stderr:\n${f.stderr.trim()}`,
    );
  }

  if (!wantAttach) {
    outro(
      `session "${sessionName}" started — attach with: agentbox claude attach ${reattachRef(box)}`,
    );
    return;
  }
  outro('attaching — Control+a d to detach, leaves claude running');
  await attachClaudeWrapped(box, sessionName, reattachRef(box), undefined, openIn);
}

const claudeAttachCommand = new Command('attach')
  .description(
    'Attach to a Claude Code tmux session in a box, starting one if none is running (auto-unpause/start; never re-syncs ~/.claude — use `claude start` for that)',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .action(async function (this: Command, idOrName: string | undefined) {
    // optsWithGlobals merges parent + own options — the parent `claude`
    // command also defines `--session-name`.
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Attaching to Claude session...');
    try {
      const attachIn = resolveAttachInOption(opts);
      const box = await resolveBoxOrExit(idOrName);
      if ((box.provider ?? 'docker') !== 'docker') {
        const cfg = await loadEffectiveConfig(box.workspacePath, {
          cliOverrides: attachIn ? { attach: { openIn: attachIn } } : {},
        });
        await cloudAgentAttach({
          box,
          binary: 'claude',
          sessionName: opts.sessionName ?? 'claude',
          mode: 'claude',
          openIn: hostAwareOpenIn(cfg),
        });
        return;
      }
      // A plain reattach must never touch host config. Force syncConfig off so
      // the no-session path starts a fresh session without the host->volume
      // rsync (which would overwrite the in-box _claude.json / prompt history).
      await startOrAttachClaude(box, [], { ...opts, syncConfig: false, attachResume: true });
    } catch (err) {
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

const claudeStartCommand = new Command('start')
  .description(
    'Start a Claude Code tmux session in an already-existing box (auto-unpause/start). If a session is already running, just attach.',
  )
  .argument(
    '[box]',
    'box ref: project index, id, id prefix, name, or container (default: the only box in this project)',
  )
  .option('--session-name <name>', 'tmux session name (default from config; built-in: claude)')
  .option(
    '--no-sync-config',
    "skip rsyncing the host's ~/.claude into the box's volume before starting (faster; use existing in-box state)",
  )
  .option('--attach-in <mode>', ATTACH_IN_HELP)
  .option('-i, --inline', INLINE_HELP)
  .option('-d, --no-attach', NO_ATTACH_HELP)
  .option(
    '-c, --continue',
    'teleport the most recent host Claude Code session for this cwd into the box and resume',
  )
  .option(
    '--resume <id>',
    'teleport the specified host Claude Code session id into the box and resume',
  )
  .argument(
    '[claude-args...]',
    'extra args passed to claude when starting a new session; ignored if a session is already running. Place after `--`, e.g. `agentbox claude start 1 -- --model sonnet`',
  )
  .action(async function (this: Command, idOrName: string | undefined, claudeArgs: string[]) {
    const opts = this.optsWithGlobals() as ClaudeStartOptions;
    intro('Starting Claude in a box...');
    try {
      const attachIn = resolveAttachInOption(opts);
      // Two positionals (`[box] [claude-args...]`) make commander bind the
      // first post-`--` token (e.g. `--model`) to `[box]`. resolveBoxOrShift
      // detects that, auto-picks the project's single box, and tells us to
      // treat the bound `idOrName` as the first claude-args token instead.
      const { box, shifted } = await resolveBoxOrShift(idOrName);
      let effectiveClaudeArgs = shifted && idOrName ? [idOrName, ...claudeArgs] : claudeArgs;
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
          resumePrepared = await prepareTeleport({
            agent: 'claude',
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
              ? { claude: { dangerouslySkipPermissions: opts.dangerouslySkipPermissions } }
              : {}),
          },
        });
        effectiveClaudeArgs = applyClaudeSkipPermissions(effectiveClaudeArgs, cfg.effective);
        if (resumePrepared) {
          try {
            const provider = await providerForBox(box);
            await uploadTeleport({ box, provider, resolved: resumePrepared });
            effectiveClaudeArgs = [...resumePrepared.forwardArgs, ...effectiveClaudeArgs];
          } catch (err) {
            if (err instanceof TeleportError) {
              log.error(err.message);
              process.exit(2);
            }
            throw err;
          }
        }
        const sessionName = opts.sessionName ?? 'claude';
        if (opts.attach === false) {
          // Background mode: start the detached session (matches docker) instead
          // of deferring the agent until the next attach.
          await cloudAgentStartDetached({
            box,
            binary: 'claude',
            sessionName,
            extraArgs: effectiveClaudeArgs,
          });
          outro(`--no-attach: claude started in background. Attach: agentbox claude attach ${reattachRef(box)}`);
          return;
        }
        await cloudAgentAttach({
          box,
          binary: 'claude',
          sessionName,
          mode: 'claude',
          extraArgs: effectiveClaudeArgs,
          openIn: hostAwareOpenIn(cfg),
        });
        return;
      }
      await startOrAttachClaude(box, effectiveClaudeArgs, opts, resumePrepared);
    } catch (err) {
      if (err instanceof ClaudeSessionError) {
        log.error(err.message);
        process.exit(1);
      }
      handleLifecycleError(err);
    }
  });

function printAwaitingCode(st: LoginState): void {
  const url = st.url ?? '';
  log.info('To finish signing in, open this URL in a browser and approve access:');
  process.stdout.write(`\n  ${url}\n\n`);
  log.info('Then run:  agentbox claude login --code <CODE>');
  // Stable, greppable marker so an orchestrating agent can grab the URL
  // deterministically regardless of how the prose above is worded.
  process.stdout.write(`AGENTBOX_LOGIN_URL=${url}\n`);
}

/**
 * Headless login (non-TTY / `--headless`): spawn the detached worker that holds
 * the live `claude auth login`, wait for it to publish the auth URL, print it +
 * the `--code` follow-up, and return while the worker keeps waiting. A second
 * `agentbox claude login --code <CODE>` ({@link deliverLoginCode}) finishes it.
 */
async function startHeadlessLogin(args: string[]): Promise<void> {
  // node-pty drives the login; without the prebuild there is no headless path.
  if (!(await loadPtyBackend())) {
    log.error(
      'Headless login needs the node-pty prebuild, which is not installed. Run `agentbox claude login` from an interactive terminal instead.',
    );
    process.exit(1);
  }
  cleanupStaleSessions();
  // Only one live session at a time. Match ANY non-terminal live session (incl.
  // a worker still in `starting`, before its URL is published) so a second
  // `--headless` can't slip through and spawn a duplicate worker.
  const existing = findLiveSession();
  if (existing) {
    if (existing.state.phase === 'awaiting-code' && existing.state.url) {
      log.info('A login is already pending; finish it (or wait for it to expire):');
      printAwaitingCode(existing.state);
    } else {
      log.info(
        'A login is already in progress; wait for it to print its URL, then finish with `agentbox claude login --code <CODE>`.',
      );
    }
    return;
  }

  const cfg = await loadEffectiveConfig(process.cwd());
  const image = cfg.effective.box.image;
  const s = spinner();
  s.start('preparing sandbox image');
  await ensureImage(image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
  s.stop('image ready');

  const id = randomUUID().slice(0, 8);
  writeLoginRequest(id, {
    image,
    extraArgs: args,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
  });

  // This foreground process IS the CLI entry, so argv[1] is the right script to
  // re-exec for the worker; AGENTBOX_CLI_ENTRY wins if a wrapper set it.
  const entry = process.env.AGENTBOX_CLI_ENTRY ?? process.argv[1];
  if (!entry || !existsSync(entry)) {
    log.error('could not resolve the agentbox CLI entry to spawn the login worker');
    process.exit(1);
  }
  const child = spawn(process.execPath, [entry, '_claude-login-worker', id], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
  // Publish a `starting` state with the worker pid immediately, so a concurrent
  // `--headless` sees a live session and won't spawn a second worker during the
  // window before the worker itself writes any state.
  if (typeof child.pid === 'number') {
    writeLoginState(id, { phase: 'starting', pid: child.pid, createdAt: new Date().toISOString() });
  }

  // Wait past the worker's own no-URL deadline (60s) so we observe its verdict
  // (awaiting-code or a published error) instead of giving up while it's still
  // working and missing the URL it later prints.
  const deadline = Date.now() + 65_000;
  for (;;) {
    const st = readLoginState(id);
    if (st?.phase === 'awaiting-code' && st.url) {
      printAwaitingCode(st);
      return;
    }
    if (st?.phase === 'error') {
      log.error(`login could not start: ${st.error ?? 'unknown error'}`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      log.error(`timed out waiting for the login URL — see ~/.agentbox/logs/claude-login-${id}.log`);
      process.exit(1);
    }
    await sleep(400);
  }
}

/** Deliver an OAuth code to the pending headless login session and report the outcome. */
async function deliverLoginCode(code: string): Promise<void> {
  cleanupStaleSessions();
  const pending = findPendingSession();
  if (!pending) {
    log.error(
      'No pending login is waiting for a code. Start one first with `agentbox claude login` (or --headless).',
    );
    process.exit(1);
  }
  const { id } = pending;
  const submittedAt = Date.now();
  writeLoginCode(id, code);

  const s = spinner();
  s.start('completing sign-in');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const st = readLoginState(id);
    if (st?.phase === 'done') {
      s.stop(st.warmed ? 'credentials ready' : 'signed in (credential check incomplete)');
      outro('signed in — credentials saved for future boxes');
      return;
    }
    if (st?.phase === 'error') {
      s.stop('sign-in failed');
      log.error(st.error ?? 'login failed');
      process.exit(1);
    }
    // Worker reverted to awaiting-code after our submit → the code was rejected;
    // the session stays valid so a corrected `--code` can retry it.
    if (st?.phase === 'awaiting-code' && st.lastError && Date.parse(st.updatedAt) >= submittedAt) {
      s.stop('code rejected');
      log.error(`${st.lastError}. Run \`agentbox claude login --code <CODE>\` again with a fresh code.`);
      process.exit(1);
    }
    if (Date.now() > deadline) {
      s.stop('sign-in timed out');
      log.error('timed out completing sign-in — see the login worker log under ~/.agentbox/logs/');
      process.exit(1);
    }
    await sleep(500);
  }
}

const claudeLoginCommand = new Command('login')
  .description(
    'Sign in to Claude for use in sandboxes (forwards args to `claude auth login`, e.g. --sso, --console). Runs in a throwaway container against the shared claude-config volume — usable before the first `agentbox claude`. In a terminal it prints the auth URL and prompts for the code. Non-interactive (no TTY) or `--headless`: prints the auth URL, then finish with `--code <CODE>`.',
  )
  .argument(
    '[args...]',
    'extra args forwarded to `claude auth login`; place after `--`, e.g. `agentbox claude login -- --sso`',
  )
  .option(
    '--headless',
    'drive login without a terminal: print the auth URL, then finish with `--code` (auto-selected when stdin is not a TTY)',
  )
  .option('--code <code>', 'deliver the OAuth code to a pending headless login session')
  .option(
    '--interactive',
    "attach your terminal to claude's own login TUI (legacy passthrough; try this if the guided prompt can't drive your login method)",
  )
  .action(async (args: string[], opts: { headless?: boolean; code?: string; interactive?: boolean }) => {
    const mode = selectLoginMode({
      isTTY: !!process.stdin.isTTY,
      headless: !!opts.headless,
      code: typeof opts.code === 'string',
      interactive: !!opts.interactive,
      ptyAvailable: !!(await loadPtyBackend()),
    });
    try {
      if (mode === 'code') {
        await deliverLoginCode(opts.code as string);
        return;
      }
      if (mode === 'headless') {
        await startHeadlessLogin(args);
        return;
      }
      intro('Signing in to Claude...');
      const cfg = await loadEffectiveConfig(process.cwd());
      const image = cfg.effective.box.image;

      const s = spinner();
      s.start('preparing sandbox image');
      await ensureImage(image, { onProgress: (line) => s.message(clampSpinnerLine(line)) });
      s.stop('image ready');

      // Throwaway `docker run` against the shared volume — the written
      // credentials persist there and `syncClaudeCredentials` mirrors them to
      // the host backup, so every later box (shared or isolate) is seeded.
      const res = await signInToClaude(image, args, { passthrough: mode === 'interactive' });
      if (res.cancelled) {
        outro('sign-in cancelled');
        process.exit(1);
      }
      if (!res.ok) {
        log.error(res.error ?? 'login failed');
        // A login method whose output we can't recognize (an exotic `-- --sso`
        // shape) never reaches a prompt; the passthrough still drives it.
        if (res.error?.includes('never printed an auth URL')) {
          log.info('Try `agentbox claude login --interactive` to use claude\'s own login TUI.');
        }
        process.exit(1);
      }
      outro('signed in — credentials saved for future boxes');
    } catch (err) {
      handleLifecycleError(err);
    }
  });

claudeCommand.addCommand(claudeAttachCommand);
claudeCommand.addCommand(claudeStartCommand);
claudeCommand.addCommand(claudeLoginCommand);
