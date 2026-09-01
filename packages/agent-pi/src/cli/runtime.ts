/**
 * Pi's docker bindings and its own sign-in code.
 *
 * Pi's shape differs from the other three in two ways worth knowing:
 *
 *  - **No skip-permissions flag**, because there are no permission prompts to
 *    skip. Pi is designed to run with full tool permissions inside a container
 *    ("Pi runs with all permissions by default" — its own containerization
 *    doc), which is exactly what a box is. `skipPermissions: null`.
 *  - **No non-interactive login.** Signing in is the in-TUI `/login` command, so
 *    every sign-in path here is the passthrough: Pi gets the user's terminal in
 *    a throwaway container mounted on the shared volume, and the `auth.json` it
 *    writes seeds every later box.
 */
import type { EffectiveConfig, UserConfig } from '@agentbox/config';
import {
  confirm,
  imageProgress,
  log,
  spinner,
  type AgentRuntime,
  type SignInResult,
} from '@agentbox/cli-kit';
import { ensureImage, extractVolumeAuthToBackup, type BoxRecord } from '@agentbox/sandbox-docker';
import { agentConfigVolume } from '@agentbox/core';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  buildPiAttachArgv,
  buildPiLoginRunArgv,
  ensurePiInstalled,
  ensurePiVolume,
  PI_FORWARDED_ENV_KEYS,
  PiSessionError,
  piSessionInfo,
  runInteractivePiLogin,
  SHARED_PI_VOLUME,
  startPiSession,
} from '../docker-sync.js';
import { piLoginBinding } from './login-binding.js';
import { piAuthAvailable } from './host-creds.js';
import { piAuthFileHasProviders } from '../auth-shape.js';

const PI_SPEC = resolveAgentSpec('pi');

/**
 * Hand the terminal to Pi in a throwaway container against the shared volume.
 *
 * This is the ONLY sign-in Pi has. `signIn`'s `passthrough` option is therefore
 * inert — there is no guided flow to opt out of — but the parameter stays in
 * the signature because the shared `<agent> login` body passes it.
 */
async function runPiLoginContainer(image: string, extraArgs: string[]): Promise<number> {
  const { exitCode } = runInteractivePiLogin(
    buildPiLoginRunArgv({ volume: SHARED_PI_VOLUME, image, extraArgs }),
  );
  return exitCode;
}

async function signInToPi(image: string, extraArgs: string[]): Promise<SignInResult> {
  if (!process.stdin.isTTY) {
    return {
      ok: false,
      error:
        'Pi can only be signed in interactively (its `/login` is a TUI slash command). Run `agentbox pi login` from a terminal, or set a provider API key such as ANTHROPIC_API_KEY.',
    };
  }
  log.info('Pi signs in from inside its own TUI: type `/login`, pick a provider, then `/exit`.');
  const exitCode = await runPiLoginContainer(image, extraArgs);
  return exitCode === 0
    ? { ok: true }
    : { ok: false, error: `\`pi\` exited with code ${String(exitCode)}` };
}

/** Shared by both first-run offers: prepare the image + volume, then sign in. */
async function runLoginOffer(image: string): Promise<boolean> {
  const s = spinner();
  s.start('preparing sandbox image');
  // The login container RUNS pi, so it needs that agent's layer — the base
  // image is agentless. `ensureImage` returns the variant ref.
  const { ref: loginImage } = await ensureImage(image, {
    agents: ['pi'],
    onProgress: imageProgress(s),
  });
  s.message('preparing pi config');
  await ensurePiVolume({ volume: SHARED_PI_VOLUME }, { syncFromHost: true, image: loginImage });
  s.stop('image ready');

  const res = await signInToPi(loginImage, []);
  if (!res.ok) {
    log.warn('Pi login did not complete; continuing — run `agentbox pi login` to retry.');
    return false;
  }
  return true;
}

/** True when the cloud push has a Pi credential source on the host. */
async function cloudPiCredAvailable(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  for (const k of PI_FORWARDED_ENV_KEYS) {
    if ((env[k] ?? '').length > 0) return true;
  }
  // Shape, not existence. `access` here would report every host that has ever
  // launched Pi as signed in, because Pi writes `{}` on first run -- the
  // sign-in offer would then never appear and the box would be seeded with an
  // empty credential. `piAuthAvailable` already had this rule; these two paths
  // did not, which is the inconsistency Bugbot caught.
  for (const p of [PI_SPEC.credential.hostBackup, join(homedir(), '.pi', 'agent', 'auth.json')]) {
    if (await piAuthFileHasProviders(p)) return true;
  }
  return false;
}

const SIGN_IN_PROMPT = 'Sign in to Pi? (opens its TUI; type /login, then /exit)';
const SKIPPED = 'Skipped sign-in — run `/login` inside the box, or set a provider API key.';

export const piRuntime: AgentRuntime = {
  hostCredStatus: async ({ image, env }) =>
    (await piAuthAvailable(image, env)) ? { status: 'ok' } : { status: 'missing' },
  sharedVolume: SHARED_PI_VOLUME,
  SessionError: PiSessionError,

  startSession: (o) =>
    startPiSession({ container: o.container, piArgs: o.args, sessionName: o.sessionName }),
  sessionInfo: (container, sessionName) => piSessionInfo(container, sessionName),
  ensureInstalled: (container, o) => ensurePiInstalled(container, o),
  ensureVolume: (target, o) =>
    ensurePiVolume(target, { syncFromHost: o.syncFromHost, image: o.image }),
  buildAttachArgv: (container, sessionName) => buildPiAttachArgv(container, sessionName),

  // Through the accessor and the GENERIC create option, not a `piConfigVolume`
  // field and a `piConfig` option of its own. The three named fields exist only
  // for boxes recorded before the keyed map; a new agent has no such history,
  // and `agentConfig` is exactly the seam that lets a fourth agent isolate.
  resolveConfigVolume: (box: BoxRecord) => agentConfigVolume(box, 'pi'),
  createBoxConfig: (isolate) => ({ agentConfig: { pi: { isolate } } }),

  sessionNameOf: (cfg: EffectiveConfig) => cfg.pi.sessionName,
  isolateOf: (cfg: EffectiveConfig) => cfg.box.isolatePiConfig,
  cliOverrides: ({ sessionName, isolate }) => {
    const out: Partial<UserConfig> = {};
    // No `dangerouslySkipPermissions`: Pi has no such flag, so the command never
    // declares the option and the config key does not exist.
    if (sessionName !== undefined) out.pi = { sessionName };
    if (isolate === true) out.box = { isolatePiConfig: true };
    return out;
  },

  skipPermissions: null,

  async offerDockerLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await piAuthAvailable(image)) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (await runLoginOffer(image)) log.success('Signed in to Pi — saved for future boxes.');
  },

  /**
   * Cloud reads the host backup (or the host's real `~/.pi/agent/auth.json`);
   * the docker login writes only to the shared volume, so after a successful
   * login we extract its `auth.json` into the backup for the cloud push to seed.
   */
  async offerCloudLogin({ image, yes }) {
    if (!process.stdin.isTTY || yes) return;
    if (await cloudPiCredAvailable()) return;
    if (!(await confirm({ message: SIGN_IN_PROMPT, initialValue: true }))) {
      log.info(SKIPPED);
      return;
    }
    if (!(await runLoginOffer(image))) return;
    const { copied } = await extractVolumeAuthToBackup({
      volume: SHARED_PI_VOLUME,
      image,
      backupFile: PI_SPEC.credential.hostBackup,
    });
    if (copied) log.success('Signed in to Pi — saved for future boxes.');
    else
      log.warn(
        'Pi login finished but no auth.json was captured — sign in inside the box if needed.',
      );
  },

  signIn: (image, extraArgs) => signInToPi(image, extraArgs),
  loginBinding: (o) => piLoginBinding(o),
  // Pi's login is its TUI; there is no keystroke-free path.
  loginNeedsTty: 'always',
  ensureInstalledOnCreate: true,

  resume: {
    /**
     * Pi organizes sessions BY WORKING DIRECTORY, and a box's cwd is always
     * `/workspace` — so `-c` inside the box resumes that box's own most recent
     * session with no id to track and no marker file to maintain (codex needs
     * one because its sessions are flat across every project).
     *
     * Still gated on a session existing: `-c` with an empty session tree starts
     * a fresh session anyway, but passing it would make the restore log claim a
     * resume that did not happen.
     */
    async resumeArgs(exec) {
      const ran = await exec(
        'find "$HOME/.pi/agent/sessions" -name "*.jsonl" -type f 2>/dev/null | head -1',
      );
      return ran.length > 0 ? ['-c'] : null;
    },
  },
};
