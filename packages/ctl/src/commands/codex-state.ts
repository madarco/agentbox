import { Command } from 'commander';
import { codexState } from '../client.js';
import { CLAUDE_ACTIVITY_STATES, DEFAULT_SOCKET_PATH, type ClaudeActivityState } from '../types.js';

interface CodexStateOptions {
  socket: string;
}

/**
 * Report Codex activity to the box supervisor. Invoked by Codex lifecycle
 * hooks seeded into the box's `~/.codex/hooks.json`. Like `claude-state`, this
 * MUST be non-disruptive: it always exits 0 (even on a bad arg or an
 * unreachable / dead daemon) with a short connect timeout, so a Codex turn is
 * never blocked or failed by a hook.
 */
export const codexStateCommand = new Command('codex-state')
  .description('Report Codex activity state to the box supervisor (used by hooks)')
  .argument('<state>', `one of: ${CLAUDE_ACTIVITY_STATES.join(', ')}`)
  .option('--socket <path>', 'unix socket path', DEFAULT_SOCKET_PATH)
  .action(async (state: string, opts: CodexStateOptions) => {
    try {
      if (CLAUDE_ACTIVITY_STATES.includes(state as ClaudeActivityState)) {
        await codexState(
          { socketPath: opts.socket, timeoutMs: 1500 },
          state as ClaudeActivityState,
        );
      }
    } catch {
      // Fire-and-forget: a missing/late daemon must never break a Codex hook.
    }
    process.exit(0);
  });
