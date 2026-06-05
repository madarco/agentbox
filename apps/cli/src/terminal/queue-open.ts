import type { QueueJobOpenTerminal } from '@agentbox/relay';
import type { QueueOpenIn } from '@agentbox/config';
import {
  cmuxBinary,
  detectHostTerminal,
  spawnInNewTerminal,
  type SpawnInNewTerminalResult,
} from './host.js';

/**
 * Capture the submitting shell's host-terminal targeting so a queued (`-i`)
 * job's worker can open a fresh terminal onto the box the moment it is ready.
 *
 * Must run on the submitting host with the live interactive env — the relay
 * daemon (which spawns the worker) is long-lived, so its own env can't be
 * trusted to point at this submit's terminal.
 *
 * Returns `undefined` when `mode` is `none` or the host terminal is not one we
 * can drive (tmux / cmux / iTerm2) — in both cases nothing is opened.
 */
export function captureOpenTerminalContext(
  mode: QueueOpenIn,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): QueueJobOpenTerminal | undefined {
  if (mode === 'none') return undefined;
  const host = detectHostTerminal(env);
  if (host === 'unknown') return undefined;

  const base = { host, mode, cwd } as const;
  if (host === 'tmux') {
    return { ...base, host, tmuxSocket: env['TMUX'], tmuxPane: env['TMUX_PANE'] };
  }
  if (host === 'cmux') {
    return {
      ...base,
      host,
      cmuxSocket: env['CMUX_SOCKET_PATH'],
      cmuxBundledCli: cmuxBinary(env),
      cmuxSurfaceId: env['CMUX_SURFACE_ID'],
      cmuxWorkspaceId: env['CMUX_WORKSPACE_ID'],
    };
  }
  // iTerm2: osascript drives the app via Apple events, no captured handle.
  return { ...base, host };
}

/**
 * Open the terminal described by a captured context, running `argv` in it. Runs
 * on the host from the queue worker once the box is ready. Rebuilds the env from
 * the captured socket(s) since the worker's own env points at the relay's
 * originating terminal, not this job's. For cmux the worker has no focused
 * surface, so it targets the captured surface/workspace by id (split → original
 * surface, then parent workspace; tab → parent workspace), degrading to a new
 * workspace only when no id resolves.
 */
export function spawnQueuedOpenTerminal(
  ctx: QueueJobOpenTerminal,
  argv: string[],
  title: string,
): Promise<SpawnInNewTerminalResult> {
  if (ctx.host === 'tmux') {
    return spawnInNewTerminal({
      host: 'tmux',
      mode: ctx.mode,
      argv,
      cwd: ctx.cwd,
      title,
      env: ctx.tmuxSocket ? { ...process.env, TMUX: ctx.tmuxSocket } : process.env,
      tmuxTarget: ctx.tmuxPane,
    });
  }
  if (ctx.host === 'cmux') {
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (ctx.cmuxSocket) env['CMUX_SOCKET_PATH'] = ctx.cmuxSocket;
    if (ctx.cmuxBundledCli) env['CMUX_BUNDLED_CLI_PATH'] = ctx.cmuxBundledCli;
    return spawnInNewTerminal({
      host: 'cmux',
      mode: ctx.mode,
      argv,
      cwd: ctx.cwd,
      title,
      env,
      cmuxTargetSurface: ctx.cmuxSurfaceId,
      cmuxTargetWorkspace: ctx.cmuxWorkspaceId,
      cmuxWorkspaceFallback: true,
    });
  }
  return spawnInNewTerminal({ host: 'iterm2', mode: ctx.mode, argv, cwd: ctx.cwd, title });
}
