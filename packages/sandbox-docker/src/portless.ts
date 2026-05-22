import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * Portless (https://portless.sh) — a host reverse-proxy that maps
 * `portless alias <name> <port>` to a stable https://<name>.localhost URL.
 *
 * AgentBox uses it to give Docker Desktop boxes a friendly web URL (OrbStack
 * already has <container>.orb.local). Portless is user-installed; AgentBox
 * never bundles, installs, or starts it — every function here is best-effort
 * and must never throw: a Portless failure degrades to the loopback URL.
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

/**
 * Resolve the user-facing URL for a registered route. Falls back to the
 * deterministic `https://<name>.localhost` when `portless get` is unavailable
 * (proxy down, route not yet registered, Portless missing).
 */
export async function portlessGetUrl(name: string): Promise<string> {
  const fallback = `https://${name}.localhost`;
  try {
    const r = await execa(PORTLESS_BIN, [SUB_GET, name], { reject: false });
    const out = (r.stdout ?? '').trim();
    if (r.exitCode === 0 && /^https?:\/\//.test(out)) return out;
  } catch {
    // fall through
  }
  return fallback;
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
 * Box env that makes the in-box browser (agent-browser → Chromium) load the
 * box's Portless `<name>.localhost` URL via the *host* Portless proxy — so the
 * web app is reachable on the exact URL the host browser uses.
 *
 * Chromium hard-codes `*.localhost` → loopback and ignores `/etc/hosts`, so
 * `--host-resolver-rules` (passed through agent-browser's `AGENT_BROWSER_ARGS`)
 * remaps the box's hostname to `host.docker.internal` — the host gateway,
 * already in every box's `/etc/hosts`. `IGNORE_HTTPS_ERRORS` covers a TLS host
 * proxy whose self-signed CA the box doesn't trust. Set at `docker run` so the
 * agent-browser daemon carries it however it first starts.
 */
export function portlessBrowserEnv(boxName: string): Record<string, string> {
  return {
    AGENT_BROWSER_ARGS: `--host-resolver-rules=MAP ${boxName}.localhost host.docker.internal`,
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
 * Start a Portless proxy with no TLS on the no-root port (`PORTLESS_PROXY_PORT`)
 * — `portless proxy start --no-tls -p <port>`. No sudo, no CA-trust prompt.
 * Idempotent: Portless reports "already running" (exit 0) if one is already up.
 * Never throws.
 */
export async function startPortlessProxy(): Promise<boolean> {
  try {
    const r = await execa(
      PORTLESS_BIN,
      ['proxy', 'start', '--no-tls', '-p', String(PORTLESS_PROXY_PORT)],
      { reject: false },
    );
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Candidate Portless state directories. `$PORTLESS_STATE_DIR` wins outright;
 * otherwise Portless picks `/tmp/portless` (proxy port < 1024, e.g. the sudo
 * :443 proxy) or `~/.portless` (>= 1024) — we check both since we don't know
 * the port.
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

/**
 * Best-effort: is a Portless proxy currently running on the host. A daemonized
 * proxy writes a live `proxy.pid`, but a `--foreground` proxy (and some daemon
 * modes) does not — so we also scan the process table. Either signal counts.
 */
async function isProxyRunning(): Promise<boolean> {
  if ((await findLivePortlessStateDir()) !== null) return true;
  try {
    const r = await execa('pgrep', ['-f', 'portless proxy'], { reject: false });
    return r.exitCode === 0 && (r.stdout ?? '').trim().length > 0;
  } catch {
    return false;
  }
}
