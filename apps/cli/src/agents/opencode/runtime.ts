/**
 * OpenCode's docker bindings and its own sign-in code.
 *
 * See `../codex/runtime.ts` for why this is separate from `./command.ts`.
 * OpenCode's shape differs from the other two in three ways worth knowing: it
 * has no skip-permissions flag, no session resume, and its `auth login` is a
 * per-provider prompt TREE rather than one prompt — which is what
 * {@link signInToOpencode} is working around.
 */
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { EffectiveConfig, UserConfig } from '@agentbox/config';
import {
  ensureImage,
  extractOpencodeCredentials,
  OPENCODE_CREDENTIALS_BACKUP_FILE,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import {
  buildOpencodeAttachArgv,
  buildOpencodeLoginRunArgv,
  ensureOpencodeInstalled,
  ensureOpencodeVolume,
  OPENCODE_FORWARDED_ENV_KEYS,
  OpencodeSessionError,
  opencodeSessionInfo,
  runInteractiveOpencodeLogin,
  SHARED_OPENCODE_VOLUME,
  startOpencodeSession,
} from '@agentbox/agent-opencode';
import { confirm, log, spinner, text } from '@agentbox/cli-kit';
import { opencodeLoginBinding } from './login-binding.js';
import { opencodeAuthAvailable } from './host-creds.js';
import { runGuidedLogin } from '@agentbox/cli-kit';
import { loadPtyBackend } from '@agentbox/cli-kit';
import { imageProgress } from '@agentbox/cli-kit';
import type { AgentRuntime, SignInResult } from '../command/types.js';

/**
 * Run `opencode auth login` in a throwaway container against the shared
 * opencode-config volume — credentials persist there and seed every later box.
 * Interactive provider picker; `extraArgs` (e.g. `--provider anthropic`) are
 * forwarded verbatim.
 *
 * This is the legacy passthrough: it hands the terminal to opencode's own TUI.
 * See {@link signInToOpencode} for why that is no longer the default.
 */
async function runOpencodeLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractiveOpencodeLogin(
    buildOpencodeLoginRunArgv({ volume: SHARED_OPENCODE_VOLUME, image, extraArgs }),
  );
  return exitCode;
}

/** The provider id already selected by a forwarded `-p` / `--provider[=id]`, if any. */
function forwardedProvider(extraArgs: string[]): string | null {
  for (let i = 0; i < extraArgs.length; i++) {
    const a = extraArgs[i] ?? '';
    if (a === '-p' || a === '--provider') return extraArgs[i + 1] ?? null;
    const eq = /^--provider=(.+)$/.exec(a);
    if (eq) return eq[1] ?? null;
  }
  return null;
}

/**
 * Sign in to OpenCode without giving the container's TUI the user's terminal (it
 * misbehaves on terminals whose keyboard protocol it mishandles — kitty's CSI-u).
 *
 * Guided mode is bounded by opencode's shape: `auth login` is a per-provider
 * prompt TREE, not one prompt. We skip its provider picker by asking for the id
 * on the host and passing `--provider` (opencode's own provider list comes from
 * models.dev, so we can't enumerate it without duplicating that registry), then
 * drive the two prompt shapes we recognize — "Enter your API key" and an OAuth
 * URL. Anything else (e.g. github-copilot's nested deployment-type select) is
 * reported as unsupported and falls back to the passthrough.
 */
async function signInToOpencode(
  image: string,
  extraArgs: string[],
  opts: { passthrough?: boolean } = {},
): Promise<SignInResult> {
  const passthrough = async (args: string[]): Promise<SignInResult> => {
    const exitCode = await runOpencodeLoginContainer(image, args);
    return exitCode === 0
      ? { ok: true }
      : { ok: false, error: `\`opencode auth login\` exited with code ${String(exitCode)}` };
  };

  if (opts.passthrough === true || !(await loadPtyBackend())) return passthrough(extraArgs);

  let args = extraArgs;
  if (!forwardedProvider(args)) {
    if (!process.stdin.isTTY) return passthrough(args);
    const provider = (
      await text({
        message: 'Which provider? (id or name, e.g. anthropic, openai, github-copilot)',
        placeholder: "leave blank to use OpenCode's own picker",
      })
    ).trim();
    // No id → we can't skip the picker, so opencode must drive its own terminal.
    if (provider.length === 0) return passthrough(args);
    args = [...args, '--provider', provider];
  }

  const loginArgs = args;
  const res = await runGuidedLogin('opencode', () =>
    opencodeLoginBinding({ image, extraArgs: loginArgs }),
  );
  // A bad provider id fails the same way in the passthrough — report it instead
  // of re-running the login just to print the same error.
  if (res.unsupported?.startsWith('unknown provider')) {
    return { ok: false, error: `opencode: ${res.unsupported}` };
  }
  if (res.unsupported) {
    log.info(
      `Guided sign-in can't drive this provider (${res.unsupported}); using OpenCode's own prompts.`,
    );
    return passthrough(args);
  }
  return { ok: res.ok, error: res.error, cancelled: res.cancelled };
}

/** Shared by both first-run offers: prepare the image + volume, then sign in. */
async function runLoginOffer(image: string): Promise<boolean> {
  const s = spinner();
  s.start('preparing sandbox image');
  // The login container RUNS opencode, so it needs that agent's layer — the
  // base image is agentless. `ensureImage` returns the variant ref.
  const { ref: loginImage } = await ensureImage(image, {
    agents: ['opencode'],
    onProgress: imageProgress(s),
  });
  // Ensure the shared volume exists (and is vscode-writable) before the login
  // container writes auth.json into it.
  s.message('preparing opencode config');
  await ensureOpencodeVolume(
    { volume: SHARED_OPENCODE_VOLUME },
    { syncFromHost: true, image: loginImage },
  );
  s.stop('image ready');

  const res = await signInToOpencode(loginImage, []);
  if (!res.ok) {
    log.warn(
      'OpenCode login did not complete; continuing — run `agentbox opencode login` to retry.',
    );
    return false;
  }
  return true;
}

/** True when the cloud push has an opencode credential source on the host. */
async function cloudOpencodeCredAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const k of OPENCODE_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  for (const p of [
    OPENCODE_CREDENTIALS_BACKUP_FILE,
    join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
  ]) {
    try {
      await access(p);
      return true;
    } catch {
      /* not present */
    }
  }
  return false;
}

const SIGN_IN_PROMPT = 'Sign in to OpenCode? (pick a provider; saved and reused by every box)';
const SKIPPED = 'Skipped sign-in — opencode will prompt you to sign in inside the box.';

export const opencodeRuntime: AgentRuntime = {
  hostCredStatus: async ({ image, env }) =>
    (await opencodeAuthAvailable(image, env)) ? { status: 'ok' } : { status: 'missing' },
  sharedVolume: SHARED_OPENCODE_VOLUME,
  SessionError: OpencodeSessionError,

  startSession: (o) =>
    startOpencodeSession({
      container: o.container,
      opencodeArgs: o.args,
      sessionName: o.sessionName,
    }),
  sessionInfo: (container, sessionName) => opencodeSessionInfo(container, sessionName),
  ensureInstalled: (container, o) => ensureOpencodeInstalled(container, o),
  ensureVolume: (target, o) =>
    ensureOpencodeVolume(target, { syncFromHost: o.syncFromHost, image: o.image }),
  buildAttachArgv: (container, sessionName) => buildOpencodeAttachArgv(container, sessionName),

  resolveConfigVolume: (box: BoxRecord) => box.opencodeConfigVolume,
  createBoxConfig: (isolate) => ({ opencodeConfig: { isolate } }),

  sessionNameOf: (cfg: EffectiveConfig) => cfg.opencode.sessionName,
  isolateOf: (cfg: EffectiveConfig) => cfg.box.isolateOpencodeConfig,
  cliOverrides: ({ sessionName, isolate }) => {
    const out: Partial<UserConfig> = {};
    // No `dangerouslySkipPermissions`: opencode has no such flag, so the command
    // never declares the option and the config key does not exist.
    if (sessionName !== undefined) out.opencode = { sessionName };
    if (isolate === true) out.box = { isolateOpencodeConfig: true };
    return out;
  },

  skipPermissions: null,

  async offerDockerLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await opencodeAuthAvailable(image)) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (await runLoginOffer(image)) log.success('Signed in to OpenCode — saved for future boxes.');
  },

  /**
   * Cloud reads the host backup `~/.agentbox/opencode-credentials.json` (or the
   * host's real `~/.local/share/opencode/auth.json`); the docker login writes
   * only to the shared volume, so after a successful login we extract its
   * `auth.json` into the backup for the cloud push to seed.
   */
  async offerCloudLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await cloudOpencodeCredAvailable()) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (!(await runLoginOffer(image))) return;
    const { copied } = await extractOpencodeCredentials(SHARED_OPENCODE_VOLUME, image);
    if (copied) log.success('Signed in to OpenCode — saved for future boxes.');
    else
      log.warn(
        'OpenCode login finished but no auth.json was captured — sign in inside the box if needed.',
      );
  },

  signIn: (image, extraArgs, o) => signInToOpencode(image, extraArgs, o),
  loginBinding: (o) => opencodeLoginBinding(o),
  // The provider picker always prompts, so there is no keystroke-free path.
  loginNeedsTty: 'always',
  ensureInstalledOnCreate: true,
};
