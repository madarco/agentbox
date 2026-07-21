import { confirm, log, spinner } from './lib/prompt.js';
import { setConfigValue } from '@agentbox/config';
import {
  detectPortless,
  type DockerEngine,
  installPortless,
  portlessInstallHint,
  portlessStartHint,
  resetPortlessCache,
  startPortlessProxy,
  startPortlessProxyRoot,
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
 * the CLI if missing, then start a proxy if none is running. We start the
 * default HTTPS proxy on :443 so box web apps get the clean
 * `https://<box>.localhost` (no port). Portless self-elevates via `sudo`, so
 * this asks for the host password once — a native GUI dialog on macOS. If the
 * user dismisses that prompt (or elevation fails) we fall back to the no-root
 * proxy (`--no-tls -p 1355`, `http://<box>.localhost:1355`) so create still
 * works. Best-effort — any failure degrades to a printed hint, never throws.
 *
 * `allowRootPrompt` gates the :443 attempt: the Docker path only reaches here
 * after an interactive "yes", but the Hetzner path calls this directly, so it
 * passes `false` for non-interactive / `--yes` runs to avoid a surprise
 * password dialog (falling straight through to the no-root :1355 proxy).
 */
export async function setupPortlessHost(
  opts: { allowRootPrompt?: boolean } = {},
): Promise<void> {
  const allowRootPrompt = opts.allowRootPrompt ?? true;
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

  // Try the clean :443 proxy first (asks for the host password once). No
  // spinner around it — the elevation prompt is modal and shouldn't race one.
  if (allowRootPrompt) {
    log.info(
      'Starting the Portless proxy on https://<box>.localhost — you may be asked for your password.',
    );
    const rootResult = await startPortlessProxyRoot();
    resetPortlessCache();
    state = await detectPortless();
    if (state.proxyRunning) {
      log.success('Portless proxy started on https://<box>.localhost');
      return;
    }
    if (rootResult === 'cancelled') {
      log.info('Password prompt dismissed — falling back to the no-root port.');
    }
  }

  // Fallback: no-root proxy on the high port (http://<box>.localhost:1355).
  const s = spinner();
  s.start('starting portless proxy (no TLS, port 1355 — no root needed)');
  await startPortlessProxy();
  resetPortlessCache();
  state = await detectPortless();
  if (state.proxyRunning) {
    // No port asserted here: the fallback usually lands on :1355, but if the
    // root :443 start actually succeeded (a racy first probe), that proxy is
    // reused instead. The real URL is resolved via `portless get` at create.
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
  // Non-interactive (`--yes`, CI, no TTY): can't prompt — adopt a running proxy
  // instead of forcing the user to opt in from a terminal first.
  if (!process.stdin.isTTY || args.yes) return resolvePortlessNonInteractive(args);

  const answer = await confirm({
    message:
      'Use Portless to give box web apps a friendly local URL? ' +
      '(installs the portless CLI and starts a local proxy if needed)',
    initialValue: true,
  });

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

/**
 * Resolve `portless.enabled` when we can't prompt — background queue jobs, the
 * tray app's hub-create path, `--yes`, CI. Honors an already-decided value
 * (config or `--portless`/`--no-portless`). Otherwise, on Docker Desktop, it
 * adopts an already-running Portless proxy — and persists the choice so later
 * runs skip re-detection, mirroring an interactive "yes" for a user who already
 * has Portless up. Without this, the first box started from the tray app never
 * uses Portless even though the proxy is live on :443, until the user happens to
 * run `agentbox` once from a real terminal. Never installs or starts a proxy
 * unasked; OrbStack needs no Portless (it has `.orb.local`).
 */
export async function resolvePortlessNonInteractive(args: {
  engine: DockerEngine;
  enabled: boolean | undefined;
  cwd: string;
}): Promise<boolean> {
  if (args.enabled !== undefined) return args.enabled;
  if (args.engine === 'orbstack') return false;
  const state = await detectPortless();
  if (state.proxyRunning) {
    try {
      await setConfigValue('global', 'portless.enabled', true, args.cwd, { raw: false });
    } catch {
      // Best-effort persist; still use the running proxy for this run.
    }
  }
  return state.proxyRunning;
}
