/**
 * Claude's docker bindings and its own sign-in code.
 *
 * See `../codex/runtime.ts` for why this is separate from `./command.ts`.
 * Claude's login is the one that is genuinely a protocol rather than a call: it
 * has a headless print-URL / `--code` pair (`./login-command.ts`) and a
 * credential-HEALTH check rather than a present/absent probe, because a merely
 * lapsed access token renews itself and nagging about it is worse than useless.
 */
import type { EffectiveConfig, UserConfig } from '@agentbox/config';
import {
  ensureImage,
  hostBackupHasCredentials,
  imageExists,
  syncClaudeCredentials,
  volumeClaudeCredentials,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import {
  buildClaudeAttachArgv,
  buildClaudeLoginRunArgv,
  ClaudeSessionError,
  claudeSessionInfo,
  ensureClaudeInstalled,
  ensureClaudeVolume,
  runInteractiveClaudeLogin,
  SHARED_CLAUDE_VOLUME,
  startClaudeSession,
  warmUpClaudeCredentials,
} from '@agentbox/agent-claude';
import { confirm, log, spinner } from '../../lib/prompt.js';
import { resolveClaudeAuth } from '../../auth.js';
import { claudeLoginBinding } from '../../lib/agent-login-bindings.js';
import { resolveClaudeCredHealth } from '../../lib/claude-cred-health.js';
import { runGuidedLogin } from '../../lib/guided-login.js';
import { imageProgress } from '../../lib/progress.js';
import { loadPtyBackend } from '../../pty/pty-backend.js';
import { applySkipPermissions, type SkipPermissionsRule } from '../../lib/skip-permissions.js';
import { clampSpinnerLine } from '../../spinner-line.js';
import { addClaudeLoginOptions, runClaudeLoginCommand } from './login-command.js';
import type { AgentRuntime, SignInResult } from '../command/types.js';

/**
 * Run `claude auth login` in a throwaway container against the shared
 * claude-config volume, then extract the result to the host backup so every
 * future box (shared or isolate) is seeded from it. Returns the login command's
 * exit code.
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
export async function signInToClaude(
  image: string,
  extraArgs: string[],
  opts: { passthrough?: boolean } = {},
): Promise<SignInResult> {
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
 * Shared tail of both first-run offers: prepare the claude image layer, seed the
 * shared volume from the host's ~/.claude, then sign in.
 *
 * The volume seed happens BEFORE the login container runs, so `claude auth
 * login` writes its oauthAccount on top of the host config (trust,
 * installMethod, project alias) rather than into an empty volume.
 * `ensureClaudeVolume` is write-once for `_claude.json`, so the later createBox
 * sync cannot clobber the login's work.
 */
async function runLoginOffer(image: string, hostWorkspace: string): Promise<void> {
  const s = spinner();
  s.start('preparing sandbox image');
  // The login container RUNS claude, so it needs that agent's layer — the base
  // image is agentless. `ensureImage` returns the variant ref.
  const { ref: loginImage } = await ensureImage(image, {
    agents: ['claude'],
    onProgress: imageProgress(s),
  });
  s.message('preparing claude config');
  await ensureClaudeVolume(
    { volume: SHARED_CLAUDE_VOLUME },
    { syncFromHost: true, image: loginImage, hostWorkspace },
  );
  s.stop('image ready');

  const res = await signInToClaude(loginImage, ['--claudeai']);
  if (!res.ok) {
    log.warn('Claude login did not complete; continuing — run `agentbox claude login` to retry.');
    return;
  }
  log.success('Signed in with your Claude subscription — saved for future boxes.');
}

const SKIPPED = 'Skipped sign-in — claude will prompt you to /login inside the box.';

/** Claude's full permission-bypass flag, and the args that mean the user chose. */
const SKIP_PERMISSIONS_RULE: SkipPermissionsRule = {
  flag: '--dangerously-skip-permissions',
  conflictingArgs: ['--dangerously-skip-permissions', '--permission-mode'],
};

export const claudeRuntime: AgentRuntime = {
  sharedVolume: SHARED_CLAUDE_VOLUME,
  SessionError: ClaudeSessionError,

  startSession: (o) =>
    startClaudeSession({
      container: o.container,
      claudeArgs: o.args,
      sessionName: o.sessionName,
      boxName: o.boxName,
      workspacePath: o.workspacePath,
    }),
  sessionInfo: (container, sessionName) => claudeSessionInfo(container, sessionName),
  ensureInstalled: (container, o) => ensureClaudeInstalled(container, o),
  ensureVolume: (target, o) =>
    ensureClaudeVolume(target, {
      syncFromHost: o.syncFromHost,
      image: o.image,
      ...(o.hostWorkspace === undefined ? {} : { hostWorkspace: o.hostWorkspace }),
    }),
  buildAttachArgv: (container, sessionName) => buildClaudeAttachArgv(container, sessionName),

  // Unlike codex/opencode, claude ALWAYS syncs: a box with no recorded volume
  // still has the shared one, and its ~/.claude carries MCP servers and OAuth
  // state the in-box claude needs.
  resolveConfigVolume: (box: BoxRecord) => box.claudeConfigVolume ?? SHARED_CLAUDE_VOLUME,
  createBoxConfig: (isolate) => ({ claudeConfig: { isolate } }),

  sessionNameOf: (cfg: EffectiveConfig) => cfg.claude.sessionName,
  isolateOf: (cfg: EffectiveConfig) => cfg.box.isolateClaudeConfig,
  cliOverrides: ({ sessionName, skipPermissions, isolate }) => {
    const out: Partial<UserConfig> = {};
    const claude: NonNullable<UserConfig['claude']> = {};
    if (sessionName !== undefined) claude.sessionName = sessionName;
    if (skipPermissions !== undefined) claude.dangerouslySkipPermissions = skipPermissions;
    if (Object.keys(claude).length > 0) out.claude = claude;
    if (isolate === true) out.box = { isolateClaudeConfig: true };
    return out;
  },

  skipPermissions: {
    flag: SKIP_PERMISSIONS_RULE.flag,
    effect: 'auto-accept tool use',
    apply: (args, cfg) =>
      applySkipPermissions(args, SKIP_PERMISSIONS_RULE, cfg.claude.dangerouslySkipPermissions),
  },

  /**
   * Host-env auth is the user's explicit choice — respect it and never check.
   * Otherwise a non-TTY run has no way to finish an in-box `/login`, so the
   * credential assertion is worth paying for.
   */
  requireCredsWhenNonTty: async () => (await resolveClaudeAuth(process.env)).source !== 'host-env',

  /**
   * Docker boots every box from the shared claude-config volume's live
   * `.credentials.json`; the host backup is only a mirror that diverges when an
   * in-box refresh fails (claude blanks the volume's refreshToken, and the
   * create-time extract then skips it, so the backup keeps a stale token). So
   * decide off the *volume*, not the backup:
   *  - usable refresh token present -> trust the in-box refresh, no prompt (a
   *    merely-expired access token renews itself; don't nag);
   *  - file present but refresh token blanked -> the login is dead (the seed only
   *    restores the same stale backup), so offer a fresh sign-in;
   *  - no file yet -> the box seeds from the host backup, so only offer sign-in
   *    when there is nothing to seed from either.
   */
  async offerDockerLogin({ image, yes, hostWorkspace }) {
    if (!process.stdin.isTTY || yes) return;
    const auth = await resolveClaudeAuth(process.env);
    if (auth.source === 'host-env') return;

    // The probe needs the image locally; skip it (fall back to the backup check)
    // when it isn't, so a first-ever run doesn't trigger an implicit pull here.
    const vol = (await imageExists(image))
      ? await volumeClaudeCredentials(SHARED_CLAUDE_VOLUME, image)
      : { present: false, hasRefreshToken: false };
    if (vol.hasRefreshToken) return;
    const blanked = vol.present && !vol.hasRefreshToken;
    if (!vol.present && (await hostBackupHasCredentials())) return;

    const message = blanked
      ? 'Your saved Claude login looks expired. Sign in again? (saved and reused by every box)'
      : auth.source === 'auth-file'
        ? "You're on a legacy API token (shows as 'Claude API'). Sign in with your Claude subscription instead?"
        : 'Sign in with your Claude subscription? (saved and reused by every box)';
    if (!(await confirm({ message, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    await runLoginOffer(image, hostWorkspace);
  },

  /**
   * Cloud has no shared volume to persist an in-box login, so without a host
   * credential the box boots unauthenticated. Capturing the login to
   * `~/.agentbox/claude-credentials.json` lets the cloud push seed it into this
   * box and every future one.
   *
   * The verdict comes from `resolveClaudeCredHealth`, which renews a merely-
   * lapsed access token rather than reporting it as an expiry — see that module
   * for why the old `expiresAt` gate nagged daily and why saying yes to it was
   * actively destructive.
   */
  async offerCloudLogin({ image, yes, hostWorkspace }) {
    if (!process.stdin.isTTY || yes) return;
    if ((await resolveClaudeAuth(process.env)).source === 'host-env') return;

    const probe = spinner();
    let started = false;
    const health = await resolveClaudeCredHealth({
      image,
      onProgress: (line) => {
        if (!started) {
          started = true;
          probe.start('checking your saved Claude login');
        }
        probe.message(clampSpinnerLine(line));
      },
    });
    if (started) probe.stop('checked your saved Claude login');
    if (health === 'ok') return;

    const message =
      health === 'dead'
        ? 'Your saved Claude login can no longer be renewed. Sign in again? (saved and reused by every box)'
        : 'Sign in with your Claude subscription? (saved and reused by every box)';
    if (!(await confirm({ message, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    await runLoginOffer(image, hostWorkspace);
  },

  signIn: (image, extraArgs, o) => signInToClaude(image, extraArgs, o),
  loginBinding: (o) => claudeLoginBinding(o),
  loginNeedsTty: 'interactive-only',
  loginCommand: { options: addClaudeLoginOptions, run: runClaudeLoginCommand },
  // Claude's create always derives an image with the agent baked in and has
  // never probed for the binary afterwards; see `ensureInstalledOnCreate`.
  ensureInstalledOnCreate: false,

  resume: {
    // Claude exposes the exact session id on every hook payload, so the in-box
    // hooks record it and resume is exact.
    async resumeArgs(exec) {
      const id = await exec('cat "$HOME/.local/state/agentbox/claude-session" 2>/dev/null');
      // Guard: only a uuid-ish token is safe to hand to `claude --resume`.
      return /^[0-9a-fA-F][0-9a-fA-F-]{7,}$/.test(id) ? ['--resume', id] : null;
    },
  },
};
