import { Command } from 'commander';
import { claudeState } from '../client.js';
import { CLAUDE_ACTIVITY_STATES, DEFAULT_SOCKET_PATH, type ClaudeActivityState } from '../types.js';

interface ClaudeStateOptions {
  socket: string;
}

/**
 * Report Claude Code activity to the box supervisor. Invoked by Claude Code
 * hooks baked into the box image's managed settings. This MUST be
 * non-disruptive: it always exits 0 (even on a bad arg or an unreachable /
 * dead daemon) and uses a short connect timeout, so a Claude turn is never
 * blocked or failed by a hook.
 */
export const claudeStateCommand = new Command('claude-state')
  .description('Report Claude activity state to the box supervisor (used by hooks)')
  .argument('<state>', `one of: ${CLAUDE_ACTIVITY_STATES.join(', ')}`)
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (state: string, opts: ClaudeStateOptions) => {
    try {
      if (CLAUDE_ACTIVITY_STATES.includes(state as ClaudeActivityState)) {
        await claudeState(
          { socketPath: opts.socket, timeoutMs: 1500 },
          state as ClaudeActivityState,
        );
      }
    } catch {
      // Fire-and-forget: a missing/late daemon must never break a Claude hook.
    }
    process.exit(0);
  });
