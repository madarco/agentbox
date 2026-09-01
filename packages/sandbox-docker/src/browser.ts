import { execInBox } from './docker.js';
import { readBoxStatus } from './sync/host-export.js';

export interface BoxBrowserResult {
  up: boolean;
  /** True when a session was already active, so we left the agent's browser untouched. */
  alreadyRunning?: boolean;
  reason?: string;
}

/**
 * Decide whether `agent-browser session list` reports a live session. Pure so
 * it can be unit-tested without docker. `agent-browser` exits 0 and prints
 * "No active sessions" when nothing is running; any other exit-0 output lists
 * one or more sessions (a persistent Chromium is up).
 */
export function browserSessionActive(stdout: string, exitCode: number): boolean {
  return exitCode === 0 && !/no active sessions/i.test(stdout);
}

/**
 * Ensure the box's in-box browser (agent-browser's persistent default-session
 * Chromium) is running, so the VNC view shows a browser instead of a blank X
 * screen. Idempotent: if a session is already active we do nothing — the agent
 * may be mid-task and we must not navigate its page away. Otherwise we open
 * `targetUrl` (default `about:blank`) **headed** (agent-browser defaults to
 * headless — a headless Chromium renders nothing on the VNC display, defeating
 * the whole point), so the agent's subsequent `agent-browser open <url>` reuses
 * the same visible window (it just navigates it). `agentbox screen` passes the
 * box's own web-service URL (`http://localhost:<expose.port>`) so the app is
 * shown *inside* the VNC desktop rather than popped open on the host.
 *
 * Best-effort, mirroring {@link import('./vnc.js').launchVncDaemon} — the
 * caller warns on failure but never aborts (the noVNC client still connects).
 * On the launcher path (see {@link desktopOpenCommand}) `up` means the launch
 * is under way, not that a page is on screen yet: the browser appears on the
 * desktop behind the launcher's own progress window, which is also where a
 * failed launch reports itself.
 * `DISPLAY=:1` + `AGENT_BROWSER_EXECUTABLE_PATH` are image-baked env so the
 * exec inherits them; runs as `vscode` like the other in-box launches.
 *
 * When `targetUrl` is the box's Portless `<name>.localhost` URL, the in-box
 * Chromium routes it back out to the host Portless proxy — the box's
 * `AGENT_BROWSER_ARGS` env (set at create, see `portlessBrowserEnv`) carries
 * the `--host-resolver-rules` that makes that work.
 */
/** Local helper — sandbox-cloud's `quoteShellArg` would be a cross-package import. */
function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

/**
 * Path of the in-box browser launcher that `agentbox-vnc-start` writes on every
 * VNC start (it wraps `agent-browser open` in an xterm progress window, which
 * doubles as the desktop dock's loading indicator while the first launch
 * downloads Chromium). `$HOME` is expanded in the box: the box user's home
 * differs per base image.
 */
const DESKTOP_LAUNCHER = '"$HOME/.local/share/agentbox/desktop/open-browser"';

/**
 * The shell command that opens the box's browser at `target`, preferring the
 * desktop launcher.
 *
 * The launcher branch is backgrounded on purpose: it lives as long as the
 * launch does (its progress window is the whole point), and a first launch —
 * a ~150MB Playwright Chromium download — outruns any exec timeout the caller
 * would be willing to wait on. It reports its own failures on the desktop, in
 * the window that showed the progress.
 *
 * The fallback branch (a box whose VNC never started, or an image baked before
 * the launcher existed) stays in the foreground, so its exit code still reaches
 * the caller the way it always did.
 */
export function desktopOpenCommand(target: string): string {
  const url = shellQuote(target);
  return (
    `if [ -x ${DESKTOP_LAUNCHER} ]; then nohup ${DESKTOP_LAUNCHER} ${url} >/dev/null 2>&1 & exit 0; fi; ` +
    `exec agent-browser open --headed ${url}`
  );
}

export async function ensureBoxBrowser(
  container: string,
  timeoutMs = 8000,
  targetUrl = 'about:blank',
): Promise<BoxBrowserResult> {
  const list = await execInBox(container, ['agent-browser', 'session', 'list'], {
    user: 'vscode',
    timeoutMs,
  });
  if (browserSessionActive(list.stdout, list.exitCode)) {
    return { up: true, alreadyRunning: true };
  }

  const open = await execInBox(container, ['bash', '-lc', desktopOpenCommand(targetUrl)], {
    user: 'vscode',
    timeoutMs,
  });
  if (open.exitCode === 0) return { up: true };
  return {
    up: false,
    reason: `agent-browser open failed: ${open.stderr || open.stdout || `exit ${String(open.exitCode)}`}`,
  };
}

export interface BoxBrowserAppResult extends BoxBrowserResult {
  /** URL the in-box browser was pointed at (`about:blank` when no web service). */
  target: string;
}

/**
 * {@link ensureBoxBrowser} with the target derived from the box itself: the
 * box's exposed web service (Portless URL preferred, in-box loopback port as
 * fallback), or `about:blank` when nothing is exposed. This is the whole
 * "the VNC desktop shows the app, not a blank X screen" step — shared by
 * `agentbox screen`, the dashboard, and the hub's open-VNC action so every
 * surface that opens the VNC viewer gets a populated desktop.
 */
export async function ensureBoxBrowserShowingApp(box: {
  container: string;
  id: string;
  name: string;
  projectIndex?: number;
  portlessUrl?: string;
}): Promise<BoxBrowserAppResult> {
  const persisted = await readBoxStatus(box);
  const exposePort = persisted?.services.find((s) => s.expose)?.expose?.port;
  const target =
    exposePort !== undefined
      ? (box.portlessUrl ?? `http://localhost:${String(exposePort)}`)
      : 'about:blank';
  const res = await ensureBoxBrowser(box.container, undefined, target);
  return { ...res, target };
}
