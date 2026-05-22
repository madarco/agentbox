import { confirm, isCancel, log, spinner } from '@clack/prompts';
import { setConfigValue } from '@agentbox/config';
import {
  detectPortless,
  type DockerEngine,
  installPortless,
  portlessInstallHint,
  portlessStartHint,
  resetPortlessCache,
  startPortlessProxy,
} from '@agentbox/sandbox-docker';

export interface PortlessPromptArgs {
  engine: DockerEngine;
  /** Effective `portless.enabled` — `undefined` means "never prompted". */
  enabled: boolean | undefined;
  yes: boolean;
  /** cwd for the config write (global scope resolves a fixed path regardless). */
  cwd: string;
}

/**
 * Bring the host Portless into a usable state after the user opts in: install
 * the CLI if missing, then start a proxy if none is running. The proxy is
 * started with `--no-tls` on a high port so it never needs root or a CA-trust
 * prompt (box web apps are then served at `http://<box>.localhost:1355`).
 * Best-effort — any failure degrades to a printed hint, never throws.
 */
async function setupPortlessHost(): Promise<void> {
  let state = await detectPortless();

  if (!state.installed) {
    const s = spinner();
    s.start('installing portless (npm install -g portless)');
    const ok = await installPortless();
    resetPortlessCache();
    s.stop(ok ? 'portless installed' : 'portless install failed');
    if (!ok) {
      log.warn(`Could not install Portless — run \`${portlessInstallHint()}\` yourself.`);
      return;
    }
    state = await detectPortless();
  }

  if (state.proxyRunning) {
    log.info('Portless proxy already running — boxes will use it.');
    return;
  }

  const s = spinner();
  s.start('starting portless proxy (no TLS, port 1355 — no root needed)');
  await startPortlessProxy();
  resetPortlessCache();
  state = await detectPortless();
  if (state.proxyRunning) {
    s.stop('portless proxy started');
  } else {
    s.stop('portless proxy did not start');
    log.warn(`Could not start the Portless proxy — run \`${portlessStartHint()}\` yourself.`);
  }
}

/**
 * First-run opt-in for Portless. On Docker Desktop there is no per-container
 * DNS, so we offer to give box web apps a friendly `<box>.localhost` URL. The
 * answer — yes or no — is persisted to the *global* config so the prompt fires
 * exactly once per machine; a "yes" also installs the CLI and starts the proxy
 * (see `setupPortlessHost`). Returns the resolved enabled flag.
 *
 * Silent no-op (returns the effective value) when: already decided in any
 * config layer or via --portless/--no-portless; non-interactive or --yes; or
 * the engine is OrbStack (which already has .orb.local).
 */
export async function maybePromptPortless(args: PortlessPromptArgs): Promise<boolean> {
  if (args.enabled !== undefined) return args.enabled;
  if (args.engine === 'orbstack') return false;
  if (!process.stdin.isTTY || args.yes) return false;

  const answer = await confirm({
    message:
      'Use Portless to give box web apps a friendly local URL? ' +
      '(installs the portless CLI and starts a local proxy if needed)',
    initialValue: true,
  });
  // Cancel (Ctrl-C) leaves the key unset so the prompt reappears next time.
  if (isCancel(answer)) return false;

  try {
    await setConfigValue('global', 'portless.enabled', answer, args.cwd, { raw: false });
  } catch (err) {
    log.warn(
      `Could not save the Portless preference: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (answer) await setupPortlessHost();
  return answer;
}
