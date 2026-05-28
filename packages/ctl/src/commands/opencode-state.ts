import { Command } from 'commander';
import { opencodeState } from '../client.js';
import { CLAUDE_ACTIVITY_STATES, DEFAULT_SOCKET_PATH, type ClaudeActivityState } from '../types.js';

interface OpencodeStateOptions {
  socket: string;
}

/**
 * Report OpenCode activity to the box supervisor. Invoked by the seeded
 * OpenCode plugin (`~/.config/opencode/plugin/agentbox-state.js`) that
 * subscribes to OpenCode's event bus and shells this command on each
 * lifecycle transition. Like `claude-state` / `codex-state`, fire-and-forget
 * — always exits 0 so a missing/late daemon never disturbs the OpenCode
 * session.
 */
export const opencodeStateCommand = new Command('opencode-state')
  .description('Report OpenCode activity state to the box supervisor (used by the plugin)')
  .argument('<state>', `one of: ${CLAUDE_ACTIVITY_STATES.join(', ')}`)
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (state: string, opts: OpencodeStateOptions) => {
    try {
      if (CLAUDE_ACTIVITY_STATES.includes(state as ClaudeActivityState)) {
        await opencodeState(
          { socketPath: opts.socket, timeoutMs: 1500 },
          state as ClaudeActivityState,
        );
      }
    } catch {
      // Fire-and-forget: a missing/late daemon must never break the OpenCode
      // plugin's event handler.
    }
    process.exit(0);
  });
