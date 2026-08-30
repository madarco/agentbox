import { Command } from 'commander';
import { agentState } from '../client.js';
import { DEFAULT_SOCKET_PATH, type AgentActivityState } from '../types.js';

interface NotifyOptions {
  socket: string;
  /** Which agent is waiting. Defaults to claude — the only agent that wired
   *  this up before the status map existed. */
  agent?: string;
  /** Reserved for future richer payload (the dashboard could surface this
   *  alongside the row indicator). Accepted but ignored in v1 so callers
   *  can already supply it. */
  message?: string;
}

/**
 * Agent-agnostic "I'm waiting for user input" signal — a short spelling of
 * `agentbox-ctl agent-state <agent> waiting` for hooks that only need this one
 * transition, carried by the same supervisor + box-status pipeline.
 *
 * `--agent` defaults to claude: this command predates the status map and used to
 * report claude's state unconditionally, so an existing hook that calls it bare
 * keeps meaning exactly what it did.
 *
 * Fire-and-forget — exits 0 even when the daemon is missing/dead, so a hook
 * that wires this up can never block or fail an agent's turn. Same safety
 * contract as `agent-state`.
 */
async function reportState(opts: NotifyOptions, state: AgentActivityState): Promise<void> {
  try {
    await agentState({ socketPath: opts.socket, timeoutMs: 1500 }, opts.agent ?? 'claude', state);
  } catch {
    // best-effort: a missing / late daemon must never break a hook.
  }
}

export const notifyCommand = new Command('notify')
  .description(
    'Signal that the in-box agent is waiting for user input (highlights the box in the dashboard)',
  )
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--agent <id>', 'which agent is waiting', 'claude')
  .option('--message <text>', 'reserved for future use; accepted but ignored in v1')
  .action(async (opts: NotifyOptions) => {
    await reportState(opts, 'waiting');
    process.exit(0);
  })
  .addCommand(
    new Command('clear')
      .description('Clear the waiting state (alias for `agent-state <agent> idle`)')
      .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
      .option('--agent <id>', 'which agent to clear', 'claude')
      .action(async (opts: NotifyOptions) => {
        await reportState(opts, 'idle');
        process.exit(0);
      }),
  );
