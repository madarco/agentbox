import type { QueueJobOpenTerminal } from '@agentbox/relay';
import type { QueueOpenIn } from '@agentbox/config';
import { cmuxBinary, detectHostTerminal } from './host.js';

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
    };
  }
  // iTerm2: osascript drives the app via Apple events, no captured handle.
  return { ...base, host };
}
