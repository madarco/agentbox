import { confirm, log, spinner } from '@agentbox/cli-kit';
import { loadEffectiveConfig, setConfigValue } from '@agentbox/config';
import {
  detectPortless,
  type DockerEngine,
  ensurePortlessProxy,
  installPortless,
  portlessInstallHint,
  portlessServiceHint,
  portlessStartHint,
  resetPortlessCache,
} from '@agentbox/sandbox-docker';
import { offerPortlessService } from './commands/install-portless.js';

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
 *
 * The :443 preference is not cosmetic. `https://<box>.localhost` is the URL a
 * cloud box mirrors internally and the one users hand-write against
 * `{{AGENTBOX_BOX_HOST}}`, so host and box only agree while the host proxy
 * serves that exact scheme and port.
 */
export async function setupPortlessHost(opts: { allowRootPrompt?: boolean } = {}): Promise<void> {
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
    // Running now, but a manually started proxy is gone after the next reboot.
    if (allowRootPrompt) await offerPortlessService();
    return;
  }

  // `ensurePortlessProxy` runs the ladder: the clean :443 proxy when we may ask
  // for a password, the no-root port when that is refused or already the mode
  // this host uses. No spinner around the root attempt — the elevation prompt is
  // modal and shouldn't race one.
  if (allowRootPrompt) {
    log.info(
      'Starting the Portless proxy on https://<box>.localhost — you may be asked for your password.',
    );
    state = await ensurePortlessProxy({ allowRootPrompt: true });
  } else {
    const s = spinner();
    s.start('starting portless proxy');
    state = await ensurePortlessProxy({ allowRootPrompt: false });
    // No port asserted here: which port comes back is whichever one this host is
    // already configured for. The real URL is resolved via `portless get`.
    s.stop(state.proxyRunning ? 'portless proxy started' : 'portless proxy did not start');
  }

  if (!state.proxyRunning) {
    log.warn(
      `Could not start the Portless proxy — run \`${portlessServiceHint()}\` (starts it at boot) ` +
        `or \`${portlessStartHint()}\` for a one-off.`,
    );
    return;
  }
  if (allowRootPrompt) {
    log.success('Portless proxy started');
    await offerPortlessService();
  }
}

/**
 * Effective `portless.enabled`, resolved against the cwd so the global layer is
 * picked up. Best effort — a config read failure leaves it `undefined`, which
 * every caller treats as "never decided", not as an opt-out.
 */
export async function resolvePortlessEnabled(): Promise<boolean | undefined> {
  try {
    const cfg = await loadEffectiveConfig(process.cwd());
    return cfg.effective.portless.enabled;
  } catch {
    return undefined;
  }
}

/**
 * Bring an already-opted-in host back to a working state without asking
 * anything. A proxy dies on reboot while its route registry survives, so
 * `portless get` keeps answering with URLs that resolve to nothing until
 * something restarts it — and before this, nothing did. Every entry point that
 * is about to hand out a `<box>.localhost` URL calls this.
 *
 * Silent by design: it never prompts for a password (the tray app, the queue
 * worker and `self-update` all reach here). It restarts the mode this host is
 * already configured for and never switches modes, so a host on the clean
 * HTTPS :443 proxy — which needs root — gets a pointer to the one-time fix
 * rather than a silently different URL. Warns once, at most.
 */
export async function ensurePortlessProxyQuietly(): Promise<void> {
  const state = await ensurePortlessProxy({ allowRootPrompt: false });
  if (!state.installed || state.proxyRunning) return;
  log.warn(
    `Portless proxy is not running — box URLs fall back to loopback ports. ` +
      `Start it at boot with \`${portlessServiceHint()}\`.`,
  );
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
  if (args.enabled !== undefined) {
    // Already decided — but "decided" only ever meant the *preference* was
    // stored. The proxy itself is not durable (a reboot kills it), so an
    // opted-in host used to sit here with dead `<box>.localhost` URLs forever.
    if (args.enabled) await ensurePortlessProxyQuietly();
    return args.enabled;
  }
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
  if (args.enabled !== undefined) {
    if (args.enabled) await ensurePortlessProxyQuietly();
    return args.enabled;
  }
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
