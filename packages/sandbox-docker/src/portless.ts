import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { execa } from 'execa';
import type { CheckResult } from '@agentbox/sandbox-core';

/**
 * Portless (https://portless.sh) — a host reverse-proxy that maps
 * `portless alias <name> <port>` to a stable https://<name>.localhost URL.
 *
 * AgentBox uses it to give a box a friendly web URL on the host. Two
 * providers consume these helpers today:
 *   - sandbox-docker: aliases the docker port-published web port
 *     (`<name>.localhost -> 127.0.0.1:<webHostPort>`). In-box browser
 *     remaps `<name>.localhost` to `host.docker.internal` because the box
 *     is in a separate net namespace.
 *   - sandbox-hetzner: aliases the SSH-forwarded loopback port for the
 *     remote VPS's WebProxy. In-box browser remaps to `127.0.0.1` because
 *     the box (= VPS) has no separate net namespace.
 *
 * The file lives in sandbox-docker for historical reasons but is shared via
 * a re-export from `@agentbox/sandbox-cloud` (Phase 1 of the hetzner work).
 * The dep direction is `sandbox-cloud → sandbox-docker`, so this is the
 * canonical home; we can't move it the other way without cycle-fixing
 * package.json wiring.
 *
 * Portless is never bundled: AgentBox installs it and starts a proxy only on
 * the user's behalf — an explicit opt-in, or on demand once they have opted in
 * (`ensurePortlessProxy`, because a proxy does not survive a reboot while its
 * route registry does). Every function here is best-effort and must never
 * throw: a Portless failure degrades to the loopback URL.
 */

/**
 * The Portless CLI surface AgentBox depends on. Pinned here so a rename in a
 * future Portless release is a one-line fix. Verified against portless 0.13.0.
 */
const PORTLESS_BIN = 'portless';
const SUB_VERSION = ['--version'];
const SUB_ALIAS = 'alias';
const SUB_ALIAS_REMOVE = '--remove';
const SUB_GET = 'get';
const SUB_SERVICE_INSTALL = ['service', 'install'];
const SUB_SERVICE_STATUS = ['service', 'status'];
const SUB_SERVICE_UNINSTALL = ['service', 'uninstall'];

/**
 * Throwaway route name used only to ask Portless which scheme/port it serves on.
 * `portless get` answers for any name, registered or not, so this needs no
 * cleanup and never appears in `portless list`.
 */
const PORTLESS_PROBE_NAME = 'agentbox-probe';

/**
 * Where Portless installs its macOS OS-startup service. Only used as a fallback
 * when `portless service status` output can't be parsed — the CLI prints this
 * exact path as "Service entry" (portless 0.13.0).
 */
const PORTLESS_LAUNCHD_PLIST = '/Library/LaunchDaemons/sh.portless.proxy.plist';

/**
 * Port AgentBox starts the Portless proxy on when it sets one up itself.
 * A port >= 1024 needs no root (Portless's own documented no-sudo port);
 * combined with `--no-tls` the whole setup runs without a single prompt.
 */
export const PORTLESS_PROXY_PORT = 1355;

export interface PortlessState {
  /** `portless` resolved on PATH and answered `--version`. */
  installed: boolean;
  /** Portless version string, when installed. */
  version?: string;
  /**
   * A live proxy daemon was found. Note `portless alias` writes the route
   * regardless — the proxy only has to be up for the URL to actually resolve.
   * `false` also covers "could not tell".
   */
  proxyRunning: boolean;
}

/** Whether Portless's own OS-startup service is installed (`portless service`). */
export interface PortlessServiceState {
  /** A boot-time service is registered, so the proxy comes back after a reboot. */
  installed: boolean;
}

let cached: PortlessState | null = null;

/**
 * Probe the host for Portless. Cached per-process like `detectEngine` — the
 * install state cannot change mid-command and the proxy state is only used
 * for a soft hint.
 */
export async function detectPortless(): Promise<PortlessState> {
  if (cached !== null) return cached;
  try {
    const ver = await execa(PORTLESS_BIN, SUB_VERSION, { reject: false });
    if (ver.exitCode !== 0) {
      cached = { installed: false, proxyRunning: false };
      return cached;
    }
    cached = {
      installed: true,
      version: (ver.stdout ?? '').trim() || undefined,
      proxyRunning: await isProxyRunning(),
    };
  } catch {
    cached = { installed: false, proxyRunning: false };
  }
  return cached;
}

/**
 * Drop the per-process probe cache so the next `detectPortless()` re-probes.
 * Called after an install / proxy-start changes the host state, and by tests.
 */
export function resetPortlessCache(): void {
  cached = null;
}

/**
 * Register (or re-point) a static route so the proxy serves
 * https://<name>.localhost -> 127.0.0.1:<port>. Returns whether Portless
 * accepted it. The route is written even when the proxy is down.
 */
export async function portlessAlias(name: string, port: number): Promise<boolean> {
  try {
    const r = await execa(PORTLESS_BIN, [SUB_ALIAS, name, String(port)], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Remove a static route registered by `portlessAlias`. */
export async function portlessUnalias(name: string): Promise<boolean> {
  try {
    const r = await execa(PORTLESS_BIN, [SUB_ALIAS, SUB_ALIAS_REMOVE, name], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Compose the URL a static route named `name` is served at, given the proxy mode. */
function composePortlessUrl(name: string, mode: { port: number; tls: boolean }): string {
  const scheme = mode.tls ? 'https' : 'http';
  const isDefaultPort = mode.tls ? mode.port === 443 : mode.port === 80;
  return `${scheme}://${name}.localhost${isDefaultPort ? '' : `:${String(mode.port)}`}`;
}

/**
 * Resolve the user-facing URL for a registered route. Falls back to the
 * deterministic `https://<name>.localhost` when `portless get` is unavailable
 * (proxy down, route not yet registered, Portless missing).
 *
 * `portless get` is **cwd-sensitive**: run from inside a git worktree it answers
 * with the worktree-scoped name it would give a dev server started there
 * (`https://<worktree>.<name>.localhost`), which is not the route
 * `portless alias` registered. AgentBox always asks about a static alias, so an
 * answer naming a different host is discarded and the URL is composed from the
 * proxy's actual scheme/port instead — otherwise the URL a box (or the hub) is
 * advertised on would depend on which directory the command ran from.
 */
export async function portlessGetUrl(name: string): Promise<string> {
  const expectedHost = `${name}.localhost`;
  try {
    const r = await execa(PORTLESS_BIN, [SUB_GET, name], { reject: false });
    const out = (r.stdout ?? '').trim();
    if (r.exitCode === 0 && /^https?:\/\//.test(out)) {
      const host = new URL(out).hostname;
      if (host === expectedHost) return out;
    }
  } catch {
    // fall through
  }
  const mode = await portlessConfiguredMode();
  return mode === null ? `https://${expectedHost}` : composePortlessUrl(name, mode);
}

/** Command the user should run to install Portless. */
export function portlessInstallHint(): string {
  return 'npm install -g portless';
}

/** Command the user should run to bring the Portless proxy up. */
export function portlessStartHint(): string {
  return 'portless proxy start';
}

/**
 * Command that makes the proxy survive a reboot. A manually started proxy dies
 * with the machine and nothing brings it back, which is the whole reason this
 * hint exists separately from `portlessStartHint`.
 */
export function portlessServiceHint(): string {
  return 'agentbox install portless';
}

/**
 * A `doctor` row (see `@agentbox/sandbox-core`'s `CheckResult`) for a provider
 * that benefits from a host Portless proxy — docker on plain Docker Desktop /
 * Linux engine (OrbStack serves `.orb.local` natively, so its `doctorChecks`
 * skips this) and hetzner (the SSH-forwarded loopback only becomes a
 * `<box>.localhost` alias with host Portless). Pure — the caller passes the
 * already-probed state so this stays offline and testable.
 */
export function portlessDoctorRow(
  state: PortlessState,
  service?: PortlessServiceState,
): CheckResult {
  if (!state.installed) {
    return {
      label: 'portless',
      status: 'warn',
      detail: 'not installed — box web URLs fall back to raw loopback ports',
      hint: `recommended: \`${portlessInstallHint()}\` for https://<box>.localhost URLs`,
    };
  }
  if (!state.proxyRunning) {
    return {
      label: 'portless',
      status: 'warn',
      detail: 'installed, proxy not running',
      // The OS service is the hint that actually sticks: `proxy start` has to be
      // re-run after every reboot, which is how a host ends up here in the first
      // place. AgentBox also starts a proxy on demand, so this is a nudge, not a
      // blocker.
      hint: `make it permanent: \`${portlessServiceHint()}\` (or one-shot: \`${portlessStartHint()}\`)`,
    };
  }
  const running = state.version ? `running · v${state.version}` : 'running';
  if (service?.installed === false) {
    return {
      label: 'portless',
      status: 'ok',
      detail: `${running} · no OS service (won't survive a reboot)`,
      hint: `optional: \`${portlessServiceHint()}\` to start it at boot`,
    };
  }
  return { label: 'portless', status: 'ok', detail: running };
}

export interface PortlessBrowserEnvOptions {
  /**
   * Where Chromium should resolve `<box-name>.localhost` to when running
   * inside the box. Docker boxes pass `host.docker.internal` (the host
   * gateway baked into every container's `/etc/hosts`). Hetzner boxes —
   * where the box *is* the VPS and WebProxy listens on the VPS's loopback —
   * pass `127.0.0.1`.
   */
  mapTarget: string;
}

/**
 * Box env that makes the in-box browser (agent-browser → Chromium) load the
 * box's Portless `<name>.localhost` URL via the *host* Portless proxy — so the
 * web app is reachable on the exact URL the host browser uses.
 *
 * Chromium hard-codes `*.localhost` → loopback and ignores `/etc/hosts`, so
 * `--host-resolver-rules` (passed through agent-browser's `AGENT_BROWSER_ARGS`)
 * remaps the box's hostname to `opts.mapTarget` — the address that, from
 * inside the box, actually reaches the host Portless proxy.
 * `IGNORE_HTTPS_ERRORS` covers a TLS host proxy whose self-signed CA the box
 * doesn't trust.
 */
export function portlessBrowserEnv(
  boxName: string,
  opts: PortlessBrowserEnvOptions,
): Record<string, string> {
  return {
    AGENT_BROWSER_ARGS: `--host-resolver-rules=MAP ${boxName}.localhost ${opts.mapTarget}`,
    AGENT_BROWSER_IGNORE_HTTPS_ERRORS: '1',
  };
}

/** Install the Portless CLI globally (`npm install -g portless`). Never throws. */
export async function installPortless(): Promise<boolean> {
  try {
    const r = await execa('npm', ['install', '-g', 'portless'], { reject: false });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Start a Portless proxy with no TLS on a no-root port (`PORTLESS_PROXY_PORT` by
 * default) — `portless proxy start --no-tls -p <port>`. No sudo, no CA-trust
 * prompt. Idempotent: Portless reports "already running" (exit 0) if one is
 * already up. Never throws.
 *
 * `port` exists so a restart lands on the port this host is *already* configured
 * for: switching ports rewrites every `<box>.localhost` URL, which is exactly
 * what must not happen behind the user's back (see `ensurePortlessProxy`).
 */
export async function startPortlessProxy(port: number = PORTLESS_PROXY_PORT): Promise<boolean> {
  try {
    const r = await execa(PORTLESS_BIN, ['proxy', 'start', '--no-tls', '-p', String(port)], {
      reject: false,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Absolute path to the `portless` binary. Needed because the macOS elevation
 * shell (`osascript … with administrator privileges`) runs with a minimal PATH
 * (`/usr/bin:/bin:/usr/sbin:/sbin`) that misses nvm / user npm prefixes where
 * `portless` usually lives. Falls back to the bare name when it can't resolve.
 */
async function resolvePortlessBin(): Promise<string> {
  try {
    // `command -v` resolves PATH the same way the shell would for the current
    // (login) environment, unlike the stripped-down elevated shell.
    const r = await execa('command', ['-v', PORTLESS_BIN], { reject: false, shell: true });
    const out = (r.stdout ?? '').trim();
    if (r.exitCode === 0 && out.startsWith('/')) return out;
  } catch {
    // fall through
  }
  return PORTLESS_BIN;
}

/** Result of a root proxy-start attempt. */
export type RootProxyStartResult =
  | 'started' // proxy is up on :443 (or was already)
  | 'cancelled' // user dismissed the elevation prompt — caller should fall back
  | 'failed'; // elevation ran but the proxy did not come up

/** Quote a string for embedding inside an AppleScript double-quoted literal. */
function escapeForAppleScript(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Single-quote a string for `/bin/sh`. Needed for the resolved portless path,
 * which can live under a home dir with spaces (`/Users/Jo Smith/.nvm/…`) that
 * the elevated shell would otherwise word-split. Single quotes survive the
 * outer AppleScript double-quoted literal untouched.
 */
function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Start the default Portless proxy — HTTPS on :443 — which requires root.
 * Portless self-elevates via its own `sudo`, so all we do is run
 * `portless proxy start && portless trust` once, as root, surfacing a single
 * password prompt. `trust` is bundled so the host browser trusts the
 * self-signed CA (otherwise 443 shows cert warnings); it is idempotent.
 *
 * On macOS the prompt is the native GUI dialog (`osascript … with administrator
 * privileges`); elsewhere we inherit the terminal so Portless's own `sudo`
 * prompt is answerable. Never throws. Returns `'cancelled'` when the user
 * dismisses the dialog so the caller can fall back to the no-root port.
 */
export async function startPortlessProxyRoot(): Promise<RootProxyStartResult> {
  const bin = await resolvePortlessBin();
  try {
    if (process.platform === 'darwin') {
      // Both commands run in one elevated shell so the user is asked once.
      const q = shellSingleQuote(bin);
      const shellCmd = `${q} proxy start && ${q} trust`;
      const script =
        `do shell script "${escapeForAppleScript(shellCmd)}" ` +
        `with administrator privileges ` +
        `with prompt "AgentBox wants to start the Portless proxy on port 443."`;
      const r = await execa('osascript', ['-e', script], { reject: false });
      if (r.exitCode === 0) return 'started';
      // osascript reports "User canceled. (-128)" when the dialog is dismissed.
      if (/User canceled|-128/i.test(r.stderr ?? '')) return 'cancelled';
      return 'failed';
    }
    // Non-macOS: let Portless's own sudo prompt reach the terminal.
    const r = await execa(bin, ['proxy', 'start'], { reject: false, stdio: 'inherit' });
    if (r.exitCode !== 0) return 'failed';
    await execa(bin, ['trust'], { reject: false, stdio: 'inherit' });
    return 'started';
  } catch {
    return 'failed';
  }
}

/**
 * Whether Portless's OS-startup service is installed — the only thing that
 * brings the proxy back after a reboot. Parses `portless service status`, whose
 * output carries an `Installed: yes|no` line (portless 0.13.0); if that shape
 * ever changes, fall back to the macOS LaunchDaemon path the same command
 * prints. Never throws — an unreadable status reads as "not installed", which
 * only costs the user an extra nudge.
 */
export async function portlessServiceStatus(): Promise<PortlessServiceState> {
  try {
    const r = await execa(PORTLESS_BIN, SUB_SERVICE_STATUS, { reject: false });
    const m = /^\s*Installed:\s*(yes|no)\s*$/im.exec(r.stdout ?? '');
    if (m) return { installed: m[1]?.toLowerCase() === 'yes' };
  } catch {
    // fall through to the filesystem probe
  }
  if (process.platform === 'darwin') return { installed: existsSync(PORTLESS_LAUNCHD_PLIST) };
  return { installed: false };
}

/**
 * Install Portless's OS-startup service (`portless service install`) so the
 * proxy is up after every reboot, and trust its CA. Needs root — same elevation
 * shape as `startPortlessProxyRoot`, so the user is asked for a password once.
 *
 * Note the service runs Portless's *default* mode: HTTPS on :443. A host that
 * was on the no-root `:1355` proxy therefore moves to clean `https://<box>.localhost`
 * URLs. AgentBox re-resolves every URL through `portless get`, so that is a
 * display change rather than breakage — but it is user-visible, so callers
 * should say so before prompting.
 */
export async function installPortlessService(): Promise<RootProxyStartResult> {
  const bin = await resolvePortlessBin();
  try {
    if (process.platform === 'darwin') {
      const q = shellSingleQuote(bin);
      const shellCmd = `${q} ${SUB_SERVICE_INSTALL.join(' ')} && ${q} trust`;
      const script =
        `do shell script "${escapeForAppleScript(shellCmd)}" ` +
        `with administrator privileges ` +
        `with prompt "AgentBox wants to start the Portless proxy at login."`;
      const r = await execa('osascript', ['-e', script], { reject: false });
      if (r.exitCode === 0) return 'started';
      if (/User canceled|-128/i.test(r.stderr ?? '')) return 'cancelled';
      return 'failed';
    }
    const r = await execa(bin, SUB_SERVICE_INSTALL, { reject: false, stdio: 'inherit' });
    if (r.exitCode !== 0) return 'failed';
    await execa(bin, ['trust'], { reject: false, stdio: 'inherit' });
    return 'started';
  } catch {
    return 'failed';
  }
}

/** Remove the OS-startup service. Never throws. */
export async function uninstallPortlessService(): Promise<boolean> {
  const bin = await resolvePortlessBin();
  try {
    if (process.platform === 'darwin') {
      const shellCmd = `${shellSingleQuote(bin)} ${SUB_SERVICE_UNINSTALL.join(' ')}`;
      const script =
        `do shell script "${escapeForAppleScript(shellCmd)}" with administrator privileges ` +
        `with prompt "AgentBox wants to remove the Portless startup service."`;
      const r = await execa('osascript', ['-e', script], { reject: false });
      return r.exitCode === 0;
    }
    const r = await execa(bin, SUB_SERVICE_UNINSTALL, { reject: false, stdio: 'inherit' });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * The proxy mode this host is already configured for, or null when Portless has
 * never served anything here. Read from `portless get` (the persisted route
 * registry), so it survives the proxy dying — which is the whole point: it tells
 * us which mode to put *back*.
 */
export async function portlessConfiguredMode(): Promise<{ port: number; tls: boolean } | null> {
  try {
    const r = await execa(PORTLESS_BIN, [SUB_GET, PORTLESS_PROBE_NAME], { reject: false });
    const out = (r.stdout ?? '').trim();
    if (r.exitCode !== 0 || !/^https?:\/\//.test(out)) return null;
    const u = new URL(out);
    const tls = u.protocol === 'https:';
    const port = u.port ? Number.parseInt(u.port, 10) : tls ? 443 : 80;
    return Number.isFinite(port) ? { port, tls } : null;
  } catch {
    return null;
  }
}

/** Ports below 1024 can only be bound by root. */
function needsRoot(port: number): boolean {
  return port < 1024;
}

/**
 * Make sure a Portless proxy is actually live, starting one if it isn't, and
 * return the resulting state.
 *
 * This exists because a proxy is not durable state: it dies on reboot, and
 * nothing (short of the OS service) brings it back — while the route registry
 * *is* durable, so `portless get` keeps answering with a URL that resolves to
 * nothing. Every AgentBox entry point that is about to hand out a
 * `<name>.localhost` URL should call this first.
 *
 * **It restarts the mode the host is already configured for, and never switches
 * modes on its own.** The scheme and port are part of the URL, and that URL is
 * shared: a cloud box mirrors the host proxy's mode inside the box, and
 * `agentbox.yaml` / env templates written against `{{AGENTBOX_BOX_HOST}}` spell
 * `https://<box>.localhost` by hand. Quietly coming back on `--no-tls -p 1355`
 * would leave the host serving one URL while the box, and everything written
 * against it, still expects another — the exact symmetry this integration exists
 * to provide.
 *
 * So when the configured mode needs root (:443, the clean HTTPS default) and we
 * are not allowed to ask for a password, this starts nothing and reports the
 * proxy as down; the caller points the user at `agentbox install portless`,
 * which fixes it permanently and without a prompt from then on. Never throws.
 */
export async function ensurePortlessProxy(
  opts: { allowRootPrompt?: boolean } = {},
): Promise<PortlessState> {
  let state = await detectPortless();
  if (!state.installed || state.proxyRunning) return state;

  const mode = await portlessConfiguredMode();
  // Nothing configured yet (a host that has never run a proxy): the clean
  // HTTPS :443 mode is the one to aim for, same as the first-run opt-in.
  const wantsRoot = mode === null || needsRoot(mode.port);

  if (wantsRoot) {
    if (opts.allowRootPrompt !== true) return state; // caller warns; no silent downgrade
    await startPortlessProxyRoot();
    resetPortlessCache();
    state = await detectPortless();
    if (state.proxyRunning) return state;
    // Elevation refused or failed. Falling back to the no-root port is a mode
    // *change*, so it is only acceptable here: an interactive caller who has
    // just been told what is happening, on a host with no live URLs to break.
  }

  await startPortlessProxy(
    mode !== null && !needsRoot(mode.port) ? mode.port : PORTLESS_PROXY_PORT,
  );
  resetPortlessCache();
  return detectPortless();
}

/**
 * Candidate Portless state directories. `$PORTLESS_STATE_DIR` wins outright;
 * otherwise Portless keeps state in `~/.portless` — even for the root :443
 * proxy, whose `proxy.pid` there stays owned by the invoking user (verified
 * against portless 0.13.0). `/tmp/portless` is retained as a legacy fallback.
 */
function portlessStateDirCandidates(): string[] {
  const env = process.env['PORTLESS_STATE_DIR'];
  if (env && env.trim().length > 0) return [env.trim()];
  return ['/tmp/portless', join(homedir(), '.portless')];
}

/**
 * Whether `pid` names a live process. `process.kill(pid, 0)` succeeds for a
 * process we own; it throws `EPERM` for one owned by another user (the proxy
 * runs as root when bound to :443 via sudo) — that still means it is alive.
 * Only `ESRCH` ("no such process") is a dead pid.
 */
function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0 = existence/permission check only
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read `<dir>/proxy.pid`, returning the pid or null when absent/garbage. */
async function readProxyPid(dir: string): Promise<number | null> {
  try {
    const raw = await readFile(join(dir, 'proxy.pid'), 'utf8');
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

/**
 * The Portless state directory whose `proxy.pid` names a live process — i.e.
 * where the *running* proxy keeps its route registry. `null` when no proxy is
 * up. This is the authoritative way to pick between `/tmp/portless` and
 * `~/.portless` (they can both exist; only one has the live proxy).
 */
async function findLivePortlessStateDir(): Promise<string | null> {
  for (const dir of portlessStateDirCandidates()) {
    const pid = await readProxyPid(dir);
    if (pid !== null && pidAlive(pid)) return dir;
  }
  return null;
}

/**
 * Resolve the host Portless state directory to bind-mount into a box (so the
 * in-box `portless` CLI shares the host's route registry). Precedence:
 *   1. an explicit override — the `portless.stateDir` config key;
 *   2. `$PORTLESS_STATE_DIR`;
 *   3. the directory of the *running* proxy (authoritative);
 *   4. whichever of `~/.portless` / `/tmp/portless` already exists;
 *   5. `~/.portless` as the final fallback.
 * Does not create the directory.
 */
export async function resolvePortlessHostStateDir(override?: string): Promise<string> {
  if (override && override.trim().length > 0) return override.trim();
  const env = process.env['PORTLESS_STATE_DIR'];
  if (env && env.trim().length > 0) return env.trim();
  const live = await findLivePortlessStateDir();
  if (live) return live;
  const home = join(homedir(), '.portless');
  if (existsSync(home)) return home;
  if (existsSync('/tmp/portless')) return '/tmp/portless';
  return home;
}

/** Whether something accepts a TCP connection on 127.0.0.1:<port>. */
async function tcpAccepts(port: number, timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port });
    const done = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      done(true);
    });
    socket.once('timeout', () => {
      done(false);
    });
    socket.once('error', () => {
      done(false);
    });
  });
}

/**
 * Best-effort: is a Portless proxy currently *serving* on this host.
 *
 * Two signals, both about the running process rather than the persisted config
 * (which survives reboots and would otherwise report a proxy that is long gone):
 *   1. a live `proxy.pid` in a Portless state dir — cheap and authoritative for
 *      a daemonized proxy;
 *   2. something accepting TCP on the port Portless is configured to serve —
 *      covers a `--foreground` proxy, which writes no pid file.
 *
 * This deliberately does NOT scan the process table. `pgrep -f "portless proxy"`
 * matches any command line that merely *contains* that phrase — a shell that ran
 * the command, an editor, a script, an agent transcript — so it reported a live
 * proxy on hosts that had none. Every "is it up?" decision here (start one or
 * not, advertise the URL or not) inverts on that answer, so a false positive is
 * worse than a missed detection: it is what leaves a user with `.localhost` URLs
 * that resolve to nothing.
 */
async function isProxyRunning(): Promise<boolean> {
  if ((await findLivePortlessStateDir()) !== null) return true;
  const mode = await portlessConfiguredMode();
  if (mode === null) return false;
  return tcpAccepts(mode.port);
}
