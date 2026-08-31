/**
 * Codex's docker bindings and its own sign-in code.
 *
 * Everything here is what `agentbox codex` needs that is specific to Codex: the
 * `@agentbox/sandbox-docker` entry points, the shared config volume, the
 * skip-permissions flag, and the guided-vs-passthrough login. It is deliberately
 * separate from `./command.ts` so a caller that only wants to restart a session
 * (`agent-sessions.ts`) can load it without pulling a commander tree behind it.
 */
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveConfig, UserConfig } from '@agentbox/config';
import {
  CODEX_CREDENTIALS_BACKUP_FILE,
  ensureImage,
  extractCodexCredentials,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import {
  buildCodexAttachArgv,
  buildCodexLoginRunArgv,
  CodexSessionError,
  codexSessionInfo,
  ensureCodexInstalled,
  ensureCodexVolume,
  runInteractiveCodexLogin,
  SHARED_CODEX_VOLUME,
  startCodexSession,
} from '../docker-sync.js';
import { confirm, log, spinner } from '@agentbox/cli-kit';
import { codexLoginBinding } from './login-binding.js';
import { codexAuthAvailable } from './host-creds.js';
import { runGuidedLogin } from '@agentbox/cli-kit';
import { loadPtyBackend } from '@agentbox/cli-kit';
import { imageProgress } from '@agentbox/cli-kit';
import { applySkipPermissions, type SkipPermissionsRule } from '@agentbox/cli-kit';
import type { AgentRuntime, SignInResult } from '@agentbox/cli-kit';

/**
 * Run `codex login` in a throwaway container against the shared codex-config
 * volume — credentials persist there and seed every later box. Defaults to the
 * `--device-auth` device-code flow (see `buildCodexLoginRunArgv`).
 *
 * This is the legacy passthrough: it hands the terminal to codex's own TUI. See
 * {@link signInToCodex} for why that is no longer the default.
 */
async function runCodexLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveCodexLogin(
    buildCodexLoginRunArgv({ volume: SHARED_CODEX_VOLUME, image, extraArgs }),
  );
  return exitCode;
}

/**
 * Sign in to Codex without giving the container's TUI the user's terminal (it
 * misbehaves on terminals whose keyboard protocol it mishandles — kitty's
 * CSI-u). Guided mode drives the login under a pty and prints the device URL +
 * one-time code from the host; the `--device-auth` flow completes in the browser,
 * so nothing is ever typed and this works with no TTY at all.
 *
 * Falls back to the passthrough when the optional node-pty prebuild is missing,
 * when the caller forces it, or when a forwarded arg selects a login method whose
 * prompts we can't drive (e.g. `-- --api-key`).
 */
async function signInToCodex(
  image: string,
  extraArgs: string[],
  opts: { passthrough?: boolean } = {},
): Promise<SignInResult> {
  const passthrough = async (): Promise<SignInResult> => {
    const exitCode = await runCodexLoginContainer(image, extraArgs);
    return exitCode === 0
      ? { ok: true }
      : { ok: false, error: `\`codex login\` exited with code ${String(exitCode)}` };
  };

  // Only the device-code flow prints a URL we can relay. Any other method
  // (`--api-key`, `--with-access-token`, …) drives its own prompts or reads
  // stdin, so don't make the user wait out the guided URL timeout first.
  const deviceAuth = extraArgs.length === 0 || extraArgs.includes('--device-auth');
  if (opts.passthrough === true || !deviceAuth || !(await loadPtyBackend())) return passthrough();

  const res = await runGuidedLogin('codex', () => codexLoginBinding({ image, extraArgs }));
  if (res.unsupported) {
    log.info(
      `Guided sign-in can't drive this login method (${res.unsupported}); using codex's own prompts.`,
    );
    return passthrough();
  }
  return { ok: res.ok, error: res.error, cancelled: res.cancelled };
}

/** Shared by both first-run offers: prepare the image + volume, then sign in. */
async function runLoginOffer(image: string): Promise<boolean> {
  const s = spinner();
  s.start('preparing sandbox image');
  // The login container RUNS codex, so it needs that agent's layer — the base
  // image is agentless. `ensureImage` returns the variant ref.
  const { ref: loginImage } = await ensureImage(image, {
    agents: ['codex'],
    onProgress: imageProgress(s),
  });
  // Ensure the shared volume exists (and is vscode-writable) before the login
  // container writes auth.json into it.
  s.message('preparing codex config');
  await ensureCodexVolume(
    { volume: SHARED_CODEX_VOLUME },
    { syncFromHost: true, image: loginImage },
  );
  s.stop('image ready');

  const res = await signInToCodex(loginImage, []);
  if (!res.ok) {
    log.warn('Codex login did not complete; continuing — run `agentbox codex login` to retry.');
    return false;
  }
  return true;
}

/** True when the cloud push has a codex credential source on the host. */
async function cloudCodexCredAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if ((env['OPENAI_API_KEY'] ?? '').length > 0) return true;
  for (const p of [CODEX_CREDENTIALS_BACKUP_FILE, join(homedir(), '.codex', 'auth.json')]) {
    try {
      await access(p);
      return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

const SIGN_IN_PROMPT = 'Sign in to Codex? (saved and reused by every box)';
const SKIPPED = 'Skipped sign-in — codex will prompt you to sign in inside the box.';

/**
 * Codex's only "never prompt" flag. It disables codex's own internal sandbox in
 * addition to approval prompts — redundant-but-safe here, since the AgentBox box
 * is already the sandbox. The rest are the user's own approval/sandbox args.
 */
const SKIP_PERMISSIONS_RULE: SkipPermissionsRule = {
  flag: '--dangerously-bypass-approvals-and-sandbox',
  conflictingArgs: [
    '--dangerously-bypass-approvals-and-sandbox',
    '--yolo',
    '--full-auto',
    '-a',
    '--ask-for-approval',
    '-s',
    '--sandbox',
  ],
};

export const codexRuntime: AgentRuntime = {
  hostCredStatus: async ({ image, env }) =>
    (await codexAuthAvailable(image, env)) ? { status: 'ok' } : { status: 'missing' },
  sharedVolume: SHARED_CODEX_VOLUME,
  SessionError: CodexSessionError,

  startSession: (o) =>
    startCodexSession({ container: o.container, codexArgs: o.args, sessionName: o.sessionName }),
  sessionInfo: (container, sessionName) => codexSessionInfo(container, sessionName),
  ensureInstalled: (container, o) => ensureCodexInstalled(container, o),
  ensureVolume: (target, o) =>
    ensureCodexVolume(target, { syncFromHost: o.syncFromHost, image: o.image }),
  buildAttachArgv: (container, sessionName) => buildCodexAttachArgv(container, sessionName),

  resolveConfigVolume: (box: BoxRecord) => box.codexConfigVolume,
  createBoxConfig: (isolate) => ({ codexConfig: { isolate } }),

  sessionNameOf: (cfg: EffectiveConfig) => cfg.codex.sessionName,
  isolateOf: (cfg: EffectiveConfig) => cfg.box.isolateCodexConfig,
  cliOverrides: ({ sessionName, skipPermissions, isolate }) => {
    const out: Partial<UserConfig> = {};
    const codex: NonNullable<UserConfig['codex']> = {};
    if (sessionName !== undefined) codex.sessionName = sessionName;
    if (skipPermissions !== undefined) codex.dangerouslySkipPermissions = skipPermissions;
    if (Object.keys(codex).length > 0) out.codex = codex;
    if (isolate === true) out.box = { isolateCodexConfig: true };
    return out;
  },

  skipPermissions: {
    flag: SKIP_PERMISSIONS_RULE.flag,
    effect: 'never prompt for approval',
    apply: (args, cfg) =>
      applySkipPermissions(args, SKIP_PERMISSIONS_RULE, cfg.codex.dangerouslySkipPermissions),
  },

  async offerDockerLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await codexAuthAvailable(image)) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (await runLoginOffer(image)) log.success('Signed in to Codex — saved for future boxes.');
  },

  /**
   * Cloud reads the host backup `~/.agentbox/codex-credentials.json` (or the
   * host's real `~/.codex/auth.json`); the docker login writes only to the shared
   * volume, so after a successful login we extract its `auth.json` into the
   * backup for the cloud push to seed.
   */
  async offerCloudLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await cloudCodexCredAvailable()) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (!(await runLoginOffer(image))) return;
    const { copied } = await extractCodexCredentials(SHARED_CODEX_VOLUME, image);
    if (copied) log.success('Signed in to Codex — saved for future boxes.');
    else
      log.warn(
        'Codex login finished but no auth.json was captured — sign in inside the box if needed.',
      );
  },

  signIn: (image, extraArgs, o) => signInToCodex(image, extraArgs, o),
  loginBinding: (o) => codexLoginBinding(o),
  // The guided device-code flow needs no keystroke, so it works without a TTY;
  // the passthrough hands codex the terminal and cannot.
  loginNeedsTty: 'interactive-only',
  ensureInstalledOnCreate: true,

  resume: {
    // Codex exposes no resumable session id, so it resumes the most recent
    // session in the box's cwd off a presence marker the in-box hooks write.
    async resumeArgs(exec) {
      const ran = await exec('test -f "$HOME/.local/state/agentbox/codex-active" && echo y');
      return ran === 'y' ? ['resume', '--last'] : null;
    },
  },
};
