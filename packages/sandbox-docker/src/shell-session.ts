import { execa } from 'execa';
import { buildTmuxSessionArgs, CONTAINER_USER } from './claude.js';

/** Default tmux session name for `agentbox shell`. */
export const DEFAULT_SHELL_SESSION = 'shell';

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
  const term = process.env['TERM'] ?? 'xterm-256color';
  return [
    'exec',
    '-it',
    '-e',
    `TERM=${term}`,
    '--user',
    user ?? CONTAINER_USER,
    container,
    'tmux',
    'attach',
    '-t',
    name,
  ];
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
