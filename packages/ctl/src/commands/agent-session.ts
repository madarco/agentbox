import { Command } from 'commander';
import { agentSession } from '../client.js';
import { DEFAULT_SOCKET_PATH } from '../types.js';

interface AgentSessionOptions {
  socket: string;
  sessionName?: string;
  json?: boolean;
}

/**
 * Probe whether an agent's tmux session is running in this box.
 *
 * Was `claude-session`. Renamed rather than kept: unlike the `<agent>-state`
 * commands — which are frozen because seeded hook files in SHARED config
 * volumes invoke them by name — this one has no caller at all. Not a seeded
 * file, not the host (which probes tmux directly through the registry's
 * `sessionInfo`), not another package.
 *
 * The default session name is the agent id, which is true for every agent the
 * registry ships, so this needs no per-agent table — the thing ctl must never
 * have, since it is baked into the image and learns its agents over
 * `agents.list`.
 */
export const agentSessionCommand = new Command('agent-session')
  .argument('<agent>', 'agent id (e.g. claude, codex, opencode)')
  .description("Report whether an agent's tmux session is running in this box")
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .option('--session-name <name>', 'tmux session name (defaults to the agent id)')
  .option('-j, --json', 'machine-readable JSON output')
  .action(async (agent: string, opts: AgentSessionOptions) => {
    const info = await agentSession({
      socketPath: opts.socket,
      sessionName: opts.sessionName ?? agent,
    });
    if (opts.json) {
      process.stdout.write(JSON.stringify(info, null, 2) + '\n');
      return;
    }
    if (info.running) {
      process.stdout.write(
        `${agent} session "${info.sessionName}" running${info.startedAt ? ` since ${info.startedAt}` : ''}\n`,
      );
    } else {
      process.stdout.write(`no ${agent} session "${info.sessionName}"\n`);
    }
  });
