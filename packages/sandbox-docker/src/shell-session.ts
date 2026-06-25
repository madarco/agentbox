import { execa } from 'execa';
import { buildTermSafeTmuxExec, buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';

/** Default tmux session name for `agentbox shell` (the box's first shell). */
export const DEFAULT_SHELL_SESSION = 'shell';

/** Reserved prefix for non-default shell sessions: `shell-2`, `shell-build`, … */
export const SHELL_SESSION_PREFIX = `${DEFAULT_SHELL_SESSION}-`;

export interface StartShellSessionOptions {
  container: string;
  sessionName?: string;
  /** In-container user (default vscode). The tmux server is per-user, so every
   *  helper here must agree on it. */
  user?: string;
  /** Pass `-l` to bash so the login profile loads (default true). */
  login?: boolean;
}

export interface ShellSessionInfo {
  running: boolean;
  sessionName: string;
}

export interface ShellSessionSummary {
  /** User-facing label: `shell` for the default, else the suffix (`2`, `build`). */
  label: string;
  /** Underlying tmux session name. */
  sessionName: string;
  /** Whether at least one client is attached. */
  attached: boolean;
  /** ISO-8601 creation time, or null when tmux didn't report it. */
  createdAt: string | null;
}

/**
 * Map a user-facing shell label to its tmux session name. The default shell
 * (`undefined` / empty / `shell`) is the bare `shell`; everything else is
 * `shell-<label>`, so every shell session shares the `shell` prefix.
 */
export function shellSessionName(label?: string): string {
  const l = (label ?? '').trim();
  if (l === '' || l === DEFAULT_SHELL_SESSION) return DEFAULT_SHELL_SESSION;
  return `${SHELL_SESSION_PREFIX}${l}`;
}

/** Inverse of {@link shellSessionName}: the user-facing label for a session. */
export function shellLabel(sessionName: string): string {
  return sessionName === DEFAULT_SHELL_SESSION
    ? DEFAULT_SHELL_SESSION
    : sessionName.slice(SHELL_SESSION_PREFIX.length);
}

/**
 * True iff a tmux session name belongs to a shell (vs the `claude` agent
 * session or a dashboard `*-dash` grouped sibling). Pure string rule — no
 * config dependency, never collides with the agent session.
 */
export function isShellSessionName(name: string): boolean {
  if (name === DEFAULT_SHELL_SESSION) return true;
  return name.startsWith(SHELL_SESSION_PREFIX) && !name.endsWith('-dash');
}

/**
 * Pick the lowest-free shell session name given the ones that already exist:
 * `shell`, then `shell-2`, `shell-3`, … (never recycles a name that is in use).
 */
export function allocateShellSessionName(existing: readonly string[]): string {
  const taken = new Set(existing);
  if (!taken.has(DEFAULT_SHELL_SESSION)) return DEFAULT_SHELL_SESSION;
  for (let n = 2; ; n++) {
    const candidate = `${SHELL_SESSION_PREFIX}${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Parse the tab-separated output of `tmux list-sessions -F
 * '#{session_name}\t#{session_created}\t#{session_attached}'`, keeping only
 * shell sessions. Default `shell` sorts first, the rest by creation time.
 */
export function parseShellSessionList(stdout: string): ShellSessionSummary[] {
  const out: ShellSessionSummary[] = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    const [name, created, attached] = line.split('\t');
    if (name === undefined || !isShellSessionName(name)) continue;
    let createdAt: string | null = null;
    const secs = Number.parseInt((created ?? '').trim(), 10);
    if (Number.isFinite(secs) && secs > 0) createdAt = new Date(secs * 1000).toISOString();
    out.push({
      label: shellLabel(name),
      sessionName: name,
      attached: Number.parseInt((attached ?? '0').trim(), 10) > 0,
      createdAt,
    });
  }
  out.sort((a, b) => {
    if (a.sessionName === DEFAULT_SHELL_SESSION) return -1;
    if (b.sessionName === DEFAULT_SHELL_SESSION) return 1;
    return (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
  });
  return out;
}

/**
 * Enumerate a box's shell tmux sessions. Best-effort: a missing tmux server,
 * a stopped/paused container, or any error surfaces as `[]`.
 */
export async function listShellSessions(
  container: string,
  user?: string,
): Promise<ShellSessionSummary[]> {
  const res = await execa(
    'docker',
    [
      'exec',
      '--user',
      user ?? CONTAINER_USER,
      container,
      'tmux',
      'list-sessions',
      '-F',
      // Literal tabs reach tmux verbatim (execa array args, no host shell).
      '#{session_name}\t#{session_created}\t#{session_attached}',
    ],
    { reject: false },
  );
  if (res.exitCode !== 0) return [];
  return parseShellSessionList(res.stdout ?? '');
}

/**
 * Start a detached tmux session running `bash` inside the container — the shell
 * counterpart of `startClaudeSession`. The session survives client disconnects;
 * reattach with {@link buildShellSessionAttachArgv}.
 *
 * We forward the host's TERM (default xterm-256color) so the in-container tmux
 * picks the right terminal-overrides at session creation time — without this,
 * docker exec defaults TERM to `xterm` and tmux can't declare 24-bit color.
 */
export async function startShellSession(opts: StartShellSessionOptions): Promise<void> {
  const sessionName = opts.sessionName ?? DEFAULT_SHELL_SESSION;
  const user = opts.user ?? CONTAINER_USER;
  const login = opts.login !== false;
  const term = process.env['TERM'] ?? 'xterm-256color';
  // tmux runs a single-arg shell-command via `/bin/sh -c`; `bash -l` / `bash`
  // need no quoting.
  const cmd = login ? 'bash -l' : 'bash';
  const result = await execa(
    'docker',
    [
      'exec',
      '-e',
      `TERM=${term}`,
      '--user',
      user,
      opts.container,
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      cmd,
      ...buildTmuxSessionArgs(sessionName),
    ],
    { reject: false },
  );
  if (result.exitCode === 0) return;
  const stderr = (result.stderr ?? '').toString();
  if (result.exitCode === 127 || /command not found|tmux: not found/i.test(stderr)) {
    throw new Error(
      `tmux is missing from the box image. Rebuild with: docker rmi agentbox/box:dev && retry.`,
    );
  }
  throw new Error(
    `failed to start shell session in ${opts.container}: ${
      stderr.trim() || `exit ${String(result.exitCode)}`
    }`,
  );
}

/**
 * The `docker` argv that attaches an interactive terminal to a box's shell
 * tmux session. `user` must match the user the session was started as (the
 * tmux server is per-user). Handed to the node-pty wrapper by `agentbox shell`.
 */
export function buildShellSessionAttachArgv(
  container: string,
  sessionName?: string,
  user?: string,
): string[] {
  const name = sessionName ?? DEFAULT_SHELL_SESSION;
  return buildTermSafeTmuxExec({
    container,
    user: user ?? CONTAINER_USER,
    tmuxScript: 'exec tmux attach -t "$1"',
    positionals: [name],
  });
}

/**
 * Best-effort: returns `{ running: false }` for any non-zero exit from
 * `tmux has-session` (covers "no server running" and "no such session").
 */
export async function shellSessionInfo(
  container: string,
  sessionName?: string,
  user?: string,
): Promise<ShellSessionInfo> {
  const name = sessionName ?? DEFAULT_SHELL_SESSION;
  const has = await execa(
    'docker',
    ['exec', '--user', user ?? CONTAINER_USER, container, 'tmux', 'has-session', '-t', name],
    { reject: false },
  );
  return { running: has.exitCode === 0, sessionName: name };
}

/**
 * Kill a box's shell tmux session (`tmux kill-session`). Returns true on a
 * clean kill, false when the session was already gone / no tmux server.
 */
export async function killShellSession(
  container: string,
  sessionName: string,
  user?: string,
): Promise<boolean> {
  const res = await execa(
    'docker',
    [
      'exec',
      '--user',
      user ?? CONTAINER_USER,
      container,
      'tmux',
      'kill-session',
      '-t',
      sessionName,
    ],
    { reject: false },
  );
  return res.exitCode === 0;
}
