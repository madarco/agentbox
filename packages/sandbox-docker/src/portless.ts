import { accessSync, constants as fsConstants, existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as netConnect } from 'node:net';
import { homedir, userInfo } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { execa } from 'execa';
import { loadEffectiveConfig } from '@agentbox/config';
import { readState, type CheckResult } from '@agentbox/sandbox-core';

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

/** The scheme and port a Portless proxy serves `<name>.localhost` on. */
export interface PortlessMode {
  port: number;
  tls: boolean;
}

export interface PortlessState {
  /**
   * The `portless` CLI answered `--version` (found on PATH or at a remembered
   * path), or a live Portless proxy answered, which implies it is installed.
   */
  installed: boolean;
  /** Portless version string, when the CLI answered. */
  version?: string;
  /**
   * A Portless proxy answered on a local port. Note `portless alias` writes the
   * route regardless — the proxy only has to be up for the URL to resolve.
   * `false` also covers "could not tell".
   */
  proxyRunning: boolean;
  /** The mode the live proxy serves, when one answered. */
  mode?: PortlessMode;
}

/** Whether Portless's own OS-startup service is installed (`portless service`). */
export interface PortlessServiceState {
  /** A boot-time service is registered, so the proxy comes back after a reboot. */
  installed: boolean;
  /**
   * The registered service is crash-looping because another proxy already holds its
   * port (Portless's own "already running on port … with a different config" exit),
   * so it would NOT bring the proxy back after a reboot. Set only when detected.
   */
  failing?: boolean;
}

/** What the service writes, each launchd restart, when a proxy it did not start holds the port. */
const SERVICE_PORT_CONFLICT = /Proxy is already running on port \d+/;

/**
 * Whether a service log shows the port-conflict crash loop: the conflict is the last
 * thing written, and it was written recently (launchd's KeepAlive retries about every
 * 10s, so a live loop keeps the file fresh). `sinceMs` narrows it further to lines
 * written after a given moment — right after a re-install, an older loop's lines are
 * still fresh and must not count. Exported for tests.
 */
export function serviceLogShowsConflict(
  tail: string,
  mtimeMs: number,
  nowMs: number,
  sinceMs = 0,
): boolean {
  if (mtimeMs < nowMs - 60_000 || mtimeMs <= sinceMs) return false;
  const lines = tail.trimEnd().split('\n');
  const recent = lines.slice(-6).join('\n');
  return SERVICE_PORT_CONFLICT.test(recent);
}

let cached: PortlessState | null = null;
let cachedAt = 0;
let inflight: Promise<PortlessState> | null = null;
let cacheGen = 0;

/**
 * How long a probe answer is reused. Short, because the long-lived hub hands out
 * box URLs from this answer: a proxy that died (reboot, crash) or was started
 * after the hub came up must show up within seconds, not at the next restart.
 * Long enough that a `list` over many boxes probes once.
 */
const PORTLESS_PROBE_TTL_MS = 5_000;

/**
 * Probe the host for Portless. Cached for a few seconds, so a command (or a hub
 * request) that asks per box probes once, while a long-lived process still sees
 * the proxy come and go.
 */
export async function detectPortless(): Promise<PortlessState> {
  if (cached !== null && Date.now() - cachedAt < PORTLESS_PROBE_TTL_MS) return cached;
  // One probe at a time: a listing asks per box in parallel, and N concurrent
  // misses would each spawn their own `portless` processes.
  if (inflight !== null) return inflight;
  const gen = cacheGen;
  const probe = probePortless().then((state) => {
    // A reset during the probe means the caller wants an answer from after it.
    if (gen === cacheGen) {
      cached = state;
      cachedAt = Date.now();
    }
    if (inflight === probe) inflight = null;
    return state;
  });
  inflight = probe;
  return probe;
}

async function probePortless(): Promise<PortlessState> {
  let version: string | undefined;
  let cliOk = false;
  try {
    const ver = await portlessExec(SUB_VERSION);
    if (ver.exitCode === 0) {
      cliOk = true;
      version = (ver.stdout ?? '').trim() || undefined;
    }
  } catch {
    // CLI unreachable from this process: liveness below does not need it.
  }
  const mode = await detectLiveMode(cliOk);
  return {
    installed: cliOk || mode !== null,
    ...(version !== undefined ? { version } : {}),
    proxyRunning: mode !== null,
    ...(mode !== null ? { mode } : {}),
  };
}

/**
 * Drop the per-process probe cache so the next `detectPortless()` re-probes.
 * Called after an install / proxy-start changes the host state, and by tests.
 */
export function resetPortlessCache(): void {
  cached = null;
  cachedAt = 0;
  inflight = null;
  cacheGen += 1;
}

/**
 * The URL a box's Portless alias is served at RIGHT NOW: composed from the live
 * proxy's mode, `undefined` when no proxy is serving (or the box has no alias).
 *
 * Never the URL on the record: the record keeps the alias forever (the route
 * registry survives a reboot) and its URL names the proxy mode at create time,
 * which is how a client ended up with a `<box>.localhost` that nothing served,
 * or the old `:1355` after the host moved to `:443`. Pure. Exported for tests.
 */
export function livePortlessUrl(
  alias: string | undefined,
  mode: PortlessMode | null | undefined,
): string | undefined {
  if (alias === undefined || !mode) return undefined;
  return composePortlessUrl(alias, mode);
}

/**
 * The mode of the Portless proxy serving right now, or null. Probe only — never
 * starts one, so it is safe in a listing loop. Never throws.
 */
export async function livePortlessMode(): Promise<PortlessMode | null> {
  try {
    return (await detectPortless()).mode ?? null;
  } catch {
    return null;
  }
}

const warnedFallback = new Set<string>();

/**
 * For a caller about to OPEN a box URL (hub `/web`, `agentbox url`): the live
 * proxy's mode, starting a proxy first when that needs no password
 * (`ensurePortlessProxy` rules: same mode as before, never a mode switch).
 * Null when none serves; says why (stderr by default) once per outage.
 * Never throws.
 */
export async function ensurePortlessForUrl(
  onWarn: (msg: string) => void = (msg) => {
    process.stderr.write(`${msg}\n`);
  },
): Promise<PortlessMode | null> {
  try {
    // Fresh probe: this answer is about to be opened, and a listing's cached
    // "live" from a few seconds ago may predate the proxy dying.
    resetPortlessCache();
    const state = await ensurePortlessProxy({ allowRootPrompt: false, allowModeChange: false });
    if (state.proxyRunning && state.mode) {
      // Re-arm: the next outage in a long-lived hub deserves its own warning.
      warnedFallback.clear();
      return state.mode;
    }
    const reason = state.installed ? 'down' : 'missing';
    if (!warnedFallback.has(reason)) {
      warnedFallback.add(reason);
      onWarn(
        state.installed
          ? `Portless proxy is not running and could not be started without a password prompt — using the loopback URL. Fix it for good with \`${portlessServiceHint()}\`.`
          : `Portless is not installed (or not found from this process) — using the loopback URL. Set it up with \`${portlessServiceHint()}\`.`,
      );
    }
    return null;
  } catch {
    return null;
  }
}

// --- locating the CLI ------------------------------------------------------

/**
 * Where AgentBox remembers the absolute `portless` path it found from a real
 * shell. The hub runs from launchd / the tray with a PATH that has no nvm
 * entry, so the bare name fails there while the user's shell finds it.
 */
function rememberedBinFile(): string {
  return join(homedir(), '.agentbox', 'portless-bin');
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** `portless` on this process's PATH, as an absolute path, without spawning. */
function findOnPath(): string | null {
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, PORTLESS_BIN);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

let resolvedCmd: string | null = null;

/**
 * The command to run Portless with. The bare name when it is on PATH;
 * otherwise an absolute path from, in order: the path remembered by
 * `rememberPortlessBin`, the running Node's own bin dir (where `npm i -g` puts
 * it under nvm), and `npm prefix -g`. Falls back to the bare name, which then
 * fails the way it always did. A found path is kept for the process.
 */
export async function portlessCmd(): Promise<string> {
  if (resolvedCmd !== null) return resolvedCmd;
  if (findOnPath() !== null) return (resolvedCmd = PORTLESS_BIN);
  const candidates: string[] = [];
  try {
    const remembered = (await readFile(rememberedBinFile(), 'utf8')).trim();
    if (remembered.startsWith('/')) candidates.push(remembered);
  } catch {
    // nothing remembered
  }
  candidates.push(join(dirname(process.execPath), PORTLESS_BIN));
  for (const c of candidates) if (isExecutable(c)) return (resolvedCmd = c);
  try {
    const r = await execa('npm', ['prefix', '-g'], { reject: false });
    const prefix = (r.stdout ?? '').trim();
    if (r.exitCode === 0 && prefix.startsWith('/')) {
      const c = join(prefix, 'bin', PORTLESS_BIN);
      if (isExecutable(c)) return (resolvedCmd = c);
    }
  } catch {
    // no npm reachable either
  }
  return PORTLESS_BIN; // not cached: a later install should be picked up
}

/**
 * Record the absolute `portless` path this process can see, for processes that
 * cannot (the hub under launchd or the tray). Called from the CLI's setup paths,
 * which run in the user's own shell. Best-effort, never throws.
 */
export async function rememberPortlessBin(): Promise<void> {
  try {
    const found = findOnPath();
    if (found === null) return;
    const abs = realpathSync(found);
    let current = '';
    try {
      current = (await readFile(rememberedBinFile(), 'utf8')).trim();
    } catch {
      // first write
    }
    if (current === abs) return;
    await mkdir(dirname(rememberedBinFile()), { recursive: true });
    await writeFile(rememberedBinFile(), `${abs}\n`);
  } catch {
    // best-effort
  }
}

/**
 * The child env for a Portless spawn: the running Node's bin dir first on PATH.
 * A remembered `portless` is usually npm's `…/portless/dist/cli.js`, whose
 * `#!/usr/bin/env node` shebang needs `node` on PATH — and the remembered path
 * is used exactly when this process's PATH (launchd, the tray) has no nvm node.
 */
function portlessChildEnv(): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);
  const path = process.env['PATH'] ?? '';
  return { ...process.env, PATH: path ? `${nodeDir}${delimiter}${path}` : nodeDir };
}

/** Run the Portless CLI with `args` (never rejects on a non-zero exit). Throws only if it cannot spawn. */
export async function portlessExec(
  args: readonly string[],
): Promise<{ exitCode: number | undefined; stdout: string; stderr: string }> {
  const r = await execa(await portlessCmd(), [...args], {
    reject: false,
    env: portlessChildEnv(),
  });
  return { exitCode: r.exitCode, stdout: String(r.stdout ?? ''), stderr: String(r.stderr ?? '') };
}

/**
 * The same PATH fix for the elevated `/bin/sh` the macOS password dialog runs
 * (`/usr/bin:/bin:/usr/sbin:/sbin`), as an env-assignment prefix.
 */
function nodePathEnvPrefix(): string {
  return `PATH=${shellSingleQuote(dirname(process.execPath))}:"$PATH" `;
}

/** Tests only: forget the resolved command. */
export function resetPortlessCmdForTests(): void {
  resolvedCmd = null;
}

// --- liveness --------------------------------------------------------------

/** Throwaway host asked of a candidate proxy; Portless answers any name. */
const PROBE_HOST = `${'agentbox-probe'}.localhost`;

/**
 * Whether a Portless proxy answers on 127.0.0.1:<port>: one request, recognised
 * by the `X-Portless` header Portless puts on every response (its own 404
 * included). A bare TCP accept is not enough — that is what read an unrelated
 * listener, or nothing behind a stale pid file, as a live proxy.
 */
async function portlessAnswersOn(mode: PortlessMode, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const opts = {
      host: '127.0.0.1',
      port: mode.port,
      path: '/',
      method: 'HEAD',
      headers: { host: PROBE_HOST },
      timeout: timeoutMs,
    };
    const onRes = (res: IncomingMessage): void => {
      res.resume();
      resolve(res.headers['x-portless'] !== undefined);
    };
    const req = mode.tls
      ? httpsRequest({ ...opts, servername: PROBE_HOST, rejectUnauthorized: false }, onRes)
      : httpRequest(opts, onRes);
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
    req.on('error', () => {
      resolve(false);
    });
    req.end();
  });
}

let answerProbe: (mode: PortlessMode) => Promise<boolean> = (m) => portlessAnswersOn(m);

/** Tests only: replace the network probe (null restores the real one). */
export function setPortlessAnswerProbeForTests(
  fn: ((mode: PortlessMode) => Promise<boolean>) | null,
): void {
  answerProbe = fn ?? ((m) => portlessAnswersOn(m));
}

/** The modes a host proxy can be on, most likely first. */
const KNOWN_MODES: PortlessMode[] = [
  { port: 443, tls: true },
  { port: PORTLESS_PROXY_PORT, tls: false },
  { port: 80, tls: false },
];

/**
 * The mode of the proxy serving right now, by asking the candidate ports: the
 * one the CLI says is configured (when the CLI is reachable), then the known
 * defaults. Needs no CLI and no pid file, so the hub sees the proxy whatever
 * its PATH.
 */
async function detectLiveMode(cliOk: boolean): Promise<PortlessMode | null> {
  const candidates: PortlessMode[] = [];
  if (cliOk) {
    const configured = await portlessConfiguredMode();
    if (configured) candidates.push(configured);
  }
  for (const m of KNOWN_MODES) {
    if (!candidates.some((c) => c.port === m.port)) candidates.push(m);
  }
  const answers = await Promise.all(candidates.map((m) => answerProbe(m).catch(() => false)));
  const i = answers.indexOf(true);
  return i === -1 ? null : (candidates[i] ?? null);
}

/**
 * Register (or re-point) a static route so the proxy serves
 * https://<name>.localhost -> 127.0.0.1:<port>. Returns whether Portless
 * accepted it. The route is written even when the proxy is down.
 */
export async function portlessAlias(name: string, port: number): Promise<boolean> {
  try {
    const r = await portlessExec([SUB_ALIAS, name, String(port)]);
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

/** Remove a static route registered by `portlessAlias`. */
export async function portlessUnalias(name: string): Promise<boolean> {
  try {
    const r = await portlessExec([SUB_ALIAS, SUB_ALIAS_REMOVE, name]);
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
    const r = await portlessExec([SUB_GET, name]);
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

// --- routing ---------------------------------------------------------------

/**
 * What the live proxy answers for a hostname. `not-routed`: its own "no app
 * registered" 404. `bad-gateway`: its own 502 — it has a route but the target
 * port does not answer (the app is down, or the route names a stale port the
 * proxy never reloaded). `unknown`: could not tell (timeout, error).
 */
export type PortlessRouteState = 'routed' | 'not-routed' | 'bad-gateway' | 'unknown';

/** The 0.15 HTML 502 page's texts (it does not name the host, so these are exact). */
const BAD_GATEWAY_TEXTS = [
  'The target app is not responding. It may have crashed.',
  'The target app may not be running.',
];

function notFoundMarker(hostname: string): string {
  return `No app registered for <strong>${hostname}</strong>`;
}

/**
 * Whether a response is Portless's own "no app registered for <host>" answer, as
 * opposed to a 404 the app behind a route sent (Portless puts `X-Portless` on
 * proxied responses too, and `{"error":"not_found"}` is a common app body). Both
 * shapes name the requested host: 0.18+ answers a non-HTML Accept with
 * `{"error":"not_found","upstream":"<host>",…}`; 0.15 always sends an HTML page
 * saying "No app registered for <strong><host></strong>". Pure.
 */
export function isPortlessNotFound(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  hostname: string,
): boolean {
  if (status !== 404 || headers['x-portless'] === undefined) return false;
  if (body.includes(notFoundMarker(hostname))) return true;
  return jsonErrorFor(body, 'not_found', hostname);
}

/**
 * Whether a response is Portless's own 502 for `hostname` (it could not reach
 * the route's target), as opposed to a 502 the app sent. 0.18+:
 * `{"error":"bad_gateway","upstream":"<host>",…}`; 0.15: an HTML page with one
 * of `BAD_GATEWAY_TEXTS`. Pure.
 */
export function isPortlessBadGateway(
  status: number,
  headers: Record<string, string | string[] | undefined>,
  body: string,
  hostname: string,
): boolean {
  if (status !== 502 || headers['x-portless'] === undefined) return false;
  if (BAD_GATEWAY_TEXTS.some((t) => body.includes(t))) return true;
  return jsonErrorFor(body, 'bad_gateway', hostname);
}

function jsonErrorFor(body: string, error: string, hostname: string): boolean {
  try {
    const json = JSON.parse(body) as { error?: unknown; upstream?: unknown };
    return json.error === error && json.upstream === hostname;
  } catch {
    return false;
  }
}

/**
 * Path the route probe asks for. Portless decides "no route" before it looks at
 * the path; a routed app gets a path it has no reason to serve, rather than a
 * GET of its root page (which can trigger a dev-server compile).
 */
const ROUTE_PROBE_PATH = '/.agentbox-route-probe';

/** One GET with `Host: <hostname>` against the live proxy. Never throws. */
async function portlessRouteStateOn(
  hostname: string,
  mode: PortlessMode,
  timeoutMs = 1500,
): Promise<PortlessRouteState> {
  return new Promise((resolve) => {
    const opts = {
      host: '127.0.0.1',
      port: mode.port,
      path: ROUTE_PROBE_PATH,
      method: 'GET',
      headers: { host: hostname, accept: 'application/json' },
      timeout: timeoutMs,
    };
    const onRes = (res: IncomingMessage): void => {
      const status = res.statusCode ?? 0;
      // Only Portless's own error pages need their body read; any other answer
      // carrying its header came through a working route.
      if (status !== 404 && status !== 502) {
        res.destroy();
        resolve(res.headers['x-portless'] !== undefined ? 'routed' : 'unknown');
        return;
      }
      // Portless 0.15's pages inline ~150KB of font CSS before the text that
      // matters, so match while streaming instead of keeping a prefix: the JSON
      // shape is small (kept whole up to 4KB), the HTML markers are searched in
      // a window that spans chunk boundaries.
      const markers = status === 404 ? [notFoundMarker(hostname)] : BAD_GATEWAY_TEXTS;
      const keep = Math.max(...markers.map((m) => m.length));
      let head = '';
      let tail = '';
      let found: string | undefined;
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        if (head.length < 4096) head += chunk.slice(0, 4096 - head.length);
        if (found !== undefined) return;
        const window = tail + chunk;
        found = markers.find((m) => window.includes(m));
        tail = window.slice(-keep);
      });
      res.on('end', () => {
        const body = found ?? head;
        if (status === 404) {
          resolve(isPortlessNotFound(404, res.headers, body, hostname) ? 'not-routed' : 'routed');
        } else {
          resolve(
            isPortlessBadGateway(502, res.headers, body, hostname) ? 'bad-gateway' : 'routed',
          );
        }
      });
      res.on('error', () => {
        resolve('unknown');
      });
    };
    const req = mode.tls
      ? httpsRequest({ ...opts, servername: hostname, rejectUnauthorized: false }, onRes)
      : httpRequest(opts, onRes);
    req.on('timeout', () => {
      req.destroy();
      resolve('unknown');
    });
    req.on('error', () => {
      resolve('unknown');
    });
    req.end();
  });
}

let routeProbe: (hostname: string, mode: PortlessMode) => Promise<PortlessRouteState> = (h, m) =>
  portlessRouteStateOn(h, m);

/** Whether something accepts a TCP connection on 127.0.0.1:<port>. Never throws. */
async function loopbackPortAnswers(port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = netConnect({ host: '127.0.0.1', port });
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => {
      done(false);
    });
    sock.once('connect', () => {
      done(true);
    });
    sock.once('error', () => {
      done(false);
    });
  });
}

let directProbe: (port: number) => Promise<boolean> = (p) => loopbackPortAnswers(p);

/**
 * "Routed" answers, reused for the probe TTL so a client resolving the same URL
 * repeatedly (the hub, the tray) asks the proxy once. Only positives are kept:
 * a broken answer must be re-checked after a re-alias.
 */
const routedAt = new Map<string, number>();

function routeKey(hostname: string, mode: PortlessMode): string {
  return `${hostname}@${String(mode.port)}`;
}

async function probeRoute(hostname: string, mode: PortlessMode): Promise<PortlessRouteState> {
  const key = routeKey(hostname, mode);
  const at = routedAt.get(key);
  if (at !== undefined && Date.now() - at < PORTLESS_PROBE_TTL_MS) return 'routed';
  const state = await routeProbe(hostname, mode);
  if (state === 'routed') routedAt.set(key, Date.now());
  else routedAt.delete(key);
  return state;
}

/** Tests only: replace the route probe (null restores the real one). Clears the cache. */
export function setPortlessRouteProbeForTests(
  fn: ((hostname: string, mode: PortlessMode) => Promise<PortlessRouteState>) | null,
): void {
  routeProbe = fn ?? ((h, m) => portlessRouteStateOn(h, m));
  routedAt.clear();
}

/** Tests only: replace the direct loopback-port check (null restores the real one). */
export function setPortlessDirectProbeForTests(
  fn: ((port: number) => Promise<boolean>) | null,
): void {
  directProbe = fn ?? ((p) => loopbackPortAnswers(p));
}

/**
 * Why a route is broken, or null when the alias is fine to hand out. A 502 is
 * broken only when the target port answers directly: then the proxy is sending
 * the alias to a port it never reloaded (a stopped/started box, a fresh SSH
 * forward). A 502 whose port is down too is just an app that is down — the
 * alias is as good a URL as loopback for that.
 */
async function routeProblem(
  state: PortlessRouteState,
  port: number | undefined,
): Promise<'not-routed' | 'stale-port' | null> {
  if (state === 'not-routed') return 'not-routed';
  if (state === 'bad-gateway' && port !== undefined && (await directProbe(port))) {
    return 'stale-port';
  }
  return null;
}

/**
 * Command that restarts the Portless boot-time service, for a proxy that
 * answers but stopped picking up route changes. Portless 0.15 watches
 * `routes.json` itself with `fs.watch`, so a newer Portless that rewrites the
 * file by rename (a new inode) leaves it watching a file that no longer exists.
 */
export function portlessRestartHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'sudo launchctl kickstart -k system/sh.portless.proxy'
    : 'sudo systemctl restart portless.service';
}

const warnedUnrouted = new Set<string>();

function clearWarned(alias: string): void {
  for (const k of warnedUnrouted) if (k.startsWith(`${alias}:`)) warnedUnrouted.delete(k);
}

let reAliasFn: (name: string, port: number) => Promise<boolean> = (n, p) => portlessAlias(n, p);

/** Tests only: replace the re-registration `routedPortlessUrl` does (null restores it). */
export function setPortlessReAliasForTests(
  fn: ((name: string, port: number) => Promise<boolean>) | null,
): void {
  reAliasFn = fn ?? ((n, p) => portlessAlias(n, p));
}

/**
 * The URL to hand out for `alias` when a caller is about to OPEN it: the live
 * URL only when the proxy actually routes `<alias>.localhost` to the right
 * port. A proxy that answers is not enough — one that stopped reloading
 * `routes.json` answers every new alias with its 404 page, and an alias whose
 * port changed since (a restarted box, a fresh SSH forward) with its 502. On
 * either, the alias is re-registered once onto `port` and checked again; still
 * broken means `undefined` (the caller falls back to loopback) and a warning
 * naming the restart. An unknown answer (timeout) keeps the alias URL: the
 * proxy answered a moment ago, and this check must not make URLs flaky.
 *
 * `port` is the loopback port the alias should point at, or a function that
 * resolves it (a cloud box's SSH forward, minted on demand). Never throws.
 */
export async function routedPortlessUrl(
  alias: string | undefined,
  mode: PortlessMode | null | undefined,
  opts: {
    port?: number | (() => Promise<number | undefined>);
    onWarn?: (msg: string) => void;
  } = {},
): Promise<string | undefined> {
  if (alias === undefined || !mode) return undefined;
  const hostname = `${alias}.localhost`;
  let resolvedPort: number | undefined;
  let portResolved = false;
  const port = async (): Promise<number | undefined> => {
    if (!portResolved) {
      portResolved = true;
      const p = opts.port;
      resolvedPort = typeof p === 'function' ? await p().catch(() => undefined) : p;
    }
    return resolvedPort;
  };
  let problem: 'not-routed' | 'stale-port' | null;
  try {
    const first = await probeRoute(hostname, mode);
    problem =
      first === 'bad-gateway'
        ? await routeProblem(first, await port())
        : await routeProblem(first, undefined);
    if (problem === null) {
      clearWarned(alias);
      return composePortlessUrl(alias, mode);
    }
    const target = await port();
    if (target !== undefined && (await reAliasFn(alias, target).catch(() => false))) {
      problem = await routeProblem(await probeRoute(hostname, mode), target);
      if (problem === null) {
        clearWarned(alias);
        return composePortlessUrl(alias, mode);
      }
    }
  } catch {
    return composePortlessUrl(alias, mode);
  }
  // Once per outage and reason: a stale port after a "no route" is news.
  const warnKey = `${alias}:${problem ?? ''}`;
  if (!warnedUnrouted.has(warnKey)) {
    warnedUnrouted.add(warnKey);
    const warn =
      opts.onWarn ??
      ((msg: string) => {
        process.stderr.write(`${msg}\n`);
      });
    const what =
      problem === 'stale-port'
        ? `sends ${hostname} to a port it has not reloaded`
        : `does not route ${hostname}`;
    warn(
      `Portless proxy ${what} (it answers, but is not reloading its routes) — using the loopback URL. Restart the Portless service: \`${portlessRestartHint()}\`.`,
    );
  }
  return undefined;
}

/**
 * Static aliases (`portless alias`, the kind AgentBox registers) in the live
 * proxy's `routes.json` that the proxy does not serve as registered: its own 404,
 * or its own 502 while the registered port answers directly (it still has an
 * older port in memory). Either means a proxy that stopped reloading routes.
 *
 * Only `pid: 0` routes count — Portless never prunes those, while a
 * `portless run` app's route legitimately disappears with its process. The
 * routes probed are the ones most likely added after a watcher died: this
 * host's box aliases first (from the box records), then the newest — Portless
 * appends, so the oldest routes are exactly the ones a stuck proxy still knows.
 * Checks at most `limit`; `[]` when it cannot tell. For `agentbox doctor`.
 * Never throws.
 */
export async function portlessBrokenRoutes(
  mode: PortlessMode,
  opts: { stateDir?: string; limit?: number; boxAliases?: string[] } = {},
): Promise<string[]> {
  try {
    const dir = await resolvePortlessHostStateDir(opts.stateDir);
    const raw = JSON.parse(await readFile(join(dir, 'routes.json'), 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    const routes = (raw as Array<{ hostname?: unknown; port?: unknown; pid?: unknown }>)
      .filter(
        (r): r is { hostname: string; port: number; pid: 0 } =>
          r.pid === 0 && typeof r.hostname === 'string' && typeof r.port === 'number',
      )
      .reverse();
    const boxHosts = new Set(
      (opts.boxAliases ?? (await recordedBoxAliases())).map((a) => `${a}.localhost`),
    );
    const ordered = [
      ...routes.filter((r) => boxHosts.has(r.hostname)),
      ...routes.filter((r) => !boxHosts.has(r.hostname)),
    ].slice(0, opts.limit ?? 8);
    const problems = await Promise.all(
      ordered.map(async (r) =>
        routeProblem(await routeProbe(r.hostname, mode).catch(() => 'unknown' as const), r.port),
      ),
    );
    return ordered.filter((_, i) => problems[i] !== null).map((r) => r.hostname);
  } catch {
    return [];
  }
}

/** Every Portless alias on this host's box records (web and VNC). Never throws. */
async function recordedBoxAliases(): Promise<string[]> {
  try {
    const state = await readState();
    return state.boxes.flatMap((b) =>
      [b.portlessAlias, b.portlessVncAlias].filter((a): a is string => typeof a === 'string'),
    );
  } catch {
    return [];
  }
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
  /** Registered routes the live proxy does not serve as registered (`portlessBrokenRoutes`). */
  unrouted: string[] = [],
): CheckResult {
  if (!state.installed) {
    return {
      label: 'portless',
      status: 'warn',
      detail: 'not installed — box web URLs fall back to raw loopback ports',
      // `agentbox install portless` installs the CLI, the boot-time service and
      // turns `portless.enabled` on: the whole setup, where `npm i -g` is a third.
      hint: `set it up: \`${portlessServiceHint()}\` for https://<box>.localhost URLs`,
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
  if (unrouted.length > 0) {
    const shown = unrouted.slice(0, 2).join(', ') + (unrouted.length > 2 ? ', …' : '');
    return {
      label: 'portless',
      status: 'warn',
      detail: `${running} · proxy not reloading routes (${shown})`,
      hint: `restart the Portless service: \`${portlessRestartHint()}\``,
    };
  }
  if (service?.failing === true) {
    return {
      label: 'portless',
      status: 'warn',
      detail: `${running} · startup service failing (another proxy holds its port)`,
      hint: `repair it: \`${portlessServiceHint()}\` (stops the other proxy, asks for your password)`,
    };
  }
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

let doctorCheck: { at: number; row: Promise<CheckResult> } | null = null;

/**
 * The `doctor` row from a live probe: state, boot service, and route reloading.
 * Several providers' doctor groups show this same row, so one doctor run
 * computes it once (reused for the probe TTL).
 */
export async function portlessDoctorCheck(stateDir?: string): Promise<CheckResult> {
  if (doctorCheck !== null && Date.now() - doctorCheck.at < PORTLESS_PROBE_TTL_MS) {
    return doctorCheck.row;
  }
  const row = (async () => {
    // The `portless.stateDir` key names where the routes live when it is set.
    const dir =
      stateDir ??
      ((await loadEffectiveConfig(process.cwd()).catch(() => null))?.effective.portless.stateDir ||
        undefined);
    const state = await detectPortless();
    const service = state.installed ? await portlessServiceStatus() : undefined;
    const unrouted =
      state.proxyRunning && state.mode
        ? await portlessBrokenRoutes(state.mode, { ...(dir ? { stateDir: dir } : {}) })
        : [];
    return portlessDoctorRow(state, service, unrouted);
  })();
  doctorCheck = { at: Date.now(), row };
  return row;
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
    const r = await portlessExec(['proxy', 'start', '--no-tls', '-p', String(port)]);
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
  const cmd = await portlessCmd();
  if (cmd.startsWith('/')) return cmd;
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
 * `SUDO_USER`/`SUDO_UID`/`SUDO_GID` assignments to prefix an elevated Portless
 * command with, or `''` when we are already root and have nothing better to say.
 *
 * Load-bearing: Portless reads those three variables to learn *whose* machine it
 * is running on. It picks the state directory from them, stamps them into the
 * LaunchDaemon plist, and chowns everything it writes in `~/.portless` back to
 * that uid/gid. `sudo` sets them; `osascript … with administrator privileges`
 * does NOT — it just runs as root with the caller's HOME. Without this prefix
 * Portless resolved uid/gid 0, baked `SUDO_UID=0` into the plist, and the
 * boot-time proxy then chowned the user's own `~/.portless` files to root:wheel,
 * breaking every later non-root `portless` command until a manual `chown -R`.
 *
 * Exported for tests.
 */
export function sudoIdentityEnvPrefix(
  user: { uid: number; gid: number; username: string } = userInfo(),
): string {
  if (user.uid <= 0 || !user.username || user.username === 'root') return '';
  return (
    `SUDO_USER=${shellSingleQuote(user.username)} ` + `SUDO_UID=${user.uid} SUDO_GID=${user.gid} `
  );
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
      const who = `${sudoIdentityEnvPrefix()}${nodePathEnvPrefix()}`;
      const shellCmd = `${who}${q} proxy start && ${who}${q} trust`;
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
    const r = await execa(bin, ['proxy', 'start'], {
      reject: false,
      stdio: 'inherit',
      env: portlessChildEnv(),
    });
    if (r.exitCode !== 0) return 'failed';
    await execa(bin, ['trust'], { reject: false, stdio: 'inherit', env: portlessChildEnv() });
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
export async function portlessServiceStatus(
  opts: { sinceMs?: number } = {},
): Promise<PortlessServiceState> {
  try {
    const r = await portlessExec(SUB_SERVICE_STATUS);
    const stdout = r.stdout ?? '';
    const m = /^\s*Installed:\s*(yes|no)\s*$/im.exec(stdout);
    if (m) {
      const installed = m[1]?.toLowerCase() === 'yes';
      if (!installed) return { installed };
      // "Installed: yes" plus "Proxy on 443: responding" can both be true while the
      // service itself crash-loops: the responding proxy is one it did not start. The
      // service log is the only place that says so.
      const dir = /^\s*State directory:\s*(.+?)\s*$/im.exec(stdout)?.[1];
      if (dir && (await serviceLogFailing(join(dir, 'service.log'), opts.sinceMs))) {
        return { installed, failing: true };
      }
      return { installed };
    }
  } catch {
    // fall through to the filesystem probe
  }
  if (process.platform === 'darwin') return { installed: existsSync(PORTLESS_LAUNCHD_PLIST) };
  return { installed: false };
}

async function serviceLogFailing(path: string, sinceMs?: number): Promise<boolean> {
  try {
    const st = await stat(path);
    const text = await readFile(path, 'utf8');
    return serviceLogShowsConflict(text.slice(-4000), st.mtimeMs, Date.now(), sinceMs);
  } catch {
    return false;
  }
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
  return (await installPortlessServiceDetailed()).result;
}

/**
 * `installPortlessService` plus the elevated shell's error text on failure, which the
 * bare result throws away — without it a failed install says nothing about why.
 */
export async function installPortlessServiceDetailed(): Promise<{
  result: RootProxyStartResult;
  detail?: string;
}> {
  const bin = await resolvePortlessBin();
  try {
    if (process.platform === 'darwin') {
      const q = shellSingleQuote(bin);
      // A Portless proxy already on :443 that the service did not start (an older
      // `proxy start`, or an orphan of a previous service) keeps the new service from
      // binding: launchd then restarts it forever while that other proxy answers, so the
      // install looks fine and is not. Portless's own pre-install stop can miss one with
      // no pid file, so stop every Portless listener on the port first, as root, in the
      // same prompt. Only processes whose command names portless are touched.
      const stopListeners =
        'for p in $(/usr/sbin/lsof -ti tcp:443 -sTCP:LISTEN); do ' +
        '/bin/ps -o command= -p $p | /usr/bin/grep -q portless && /bin/kill $p; done; ' +
        'sleep 1';
      const who = `${sudoIdentityEnvPrefix()}${nodePathEnvPrefix()}`;
      const shellCmd = `${stopListeners}; ${who}${q} ${SUB_SERVICE_INSTALL.join(' ')} && ${who}${q} trust`;
      const script =
        `do shell script "${escapeForAppleScript(shellCmd)}" ` +
        `with administrator privileges ` +
        `with prompt "AgentBox wants to start the Portless proxy at login."`;
      const r = await execa('osascript', ['-e', script], { reject: false });
      if (r.exitCode === 0) return { result: 'started' };
      if (/User canceled|-128/i.test(r.stderr ?? '')) return { result: 'cancelled' };
      return { result: 'failed', detail: lastLine(r.stderr ?? '') };
    }
    const r = await execa(bin, SUB_SERVICE_INSTALL, {
      reject: false,
      stdio: 'inherit',
      env: portlessChildEnv(),
    });
    if (r.exitCode !== 0) return { result: 'failed' };
    await execa(bin, ['trust'], { reject: false, stdio: 'inherit', env: portlessChildEnv() });
    return { result: 'started' };
  } catch (err) {
    return { result: 'failed', detail: err instanceof Error ? err.message : String(err) };
  }
}

function lastLine(text: string): string | undefined {
  // osascript prefixes the shell's output with "0:12: execution error: ".
  const line = text
    .trim()
    .split('\n')
    .pop()
    ?.replace(/^\d+:\d+: execution error: /, '')
    .trim();
  return line ? line : undefined;
}

/** Remove the OS-startup service. Never throws. */
export async function uninstallPortlessService(): Promise<boolean> {
  const bin = await resolvePortlessBin();
  try {
    if (process.platform === 'darwin') {
      const shellCmd = `${nodePathEnvPrefix()}${shellSingleQuote(bin)} ${SUB_SERVICE_UNINSTALL.join(' ')}`;
      const script =
        `do shell script "${escapeForAppleScript(shellCmd)}" with administrator privileges ` +
        `with prompt "AgentBox wants to remove the Portless startup service."`;
      const r = await execa('osascript', ['-e', script], { reject: false });
      return r.exitCode === 0;
    }
    const r = await execa(bin, SUB_SERVICE_UNINSTALL, {
      reject: false,
      stdio: 'inherit',
      env: portlessChildEnv(),
    });
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
    const r = await portlessExec([SUB_GET, PORTLESS_PROBE_NAME]);
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
  opts: {
    allowRootPrompt?: boolean;
    /**
     * May a refused/failed :443 start fall back to the no-root port? Only for a
     * first setup on a host with no live `<box>.localhost` URLs: anywhere else
     * it silently rewrites every box URL (default true, for that first setup).
     */
    allowModeChange?: boolean;
  } = {},
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
    // *change*, so it is only acceptable for a caller that says the host has no
    // live URLs to break.
    if (opts.allowModeChange === false) return state;
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

/** Where a docker box keeps its copy of the host's Portless CA. */
export const BOX_PORTLESS_CA_PATH = '/etc/agentbox/portless-host-ca.pem';

/**
 * The host Portless CA certificate (`<stateDir>/ca.pem`) a box should trust, or
 * `null` when the host has none (a no-TLS proxy never makes one). Boxes get a
 * copy of this one public file, never a mount of the state dir: that holds the
 * CA's private key and the `routes.json` the host proxy watches. Never throws.
 */
export async function hostPortlessCaPath(stateDirOverride?: string): Promise<string | null> {
  try {
    const ca = join(await resolvePortlessHostStateDir(stateDirOverride), 'ca.pem');
    return (await stat(ca)).isFile() ? ca : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the host Portless state directory (where its CA and `routes.json`
 * live). Precedence:
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
