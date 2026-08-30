import type { QueueAgentKind } from './sync/agent-kind.js';

export interface AgentLauncher {
  readonly kind: QueueAgentKind;
  buildArgs(initialMessage: string, userArgs: string[]): string[];
}

/**
 * Every agent we ship takes a leading positional as the seed user turn
 * (`claude "<msg>"`, `codex "<msg>"`, `opencode "<msg>"`), dropping the user into
 * the TUI with that turn pre-submitted — so one launcher serves all of them.
 *
 * The indirection stays because the shape is not guaranteed: an agent that wants
 * its seed prompt on stdin, or behind a flag, gets its own launcher here without
 * every call site learning about it.
 */
function positionalSeedLauncher(kind: QueueAgentKind): AgentLauncher {
  return {
    kind,
    buildArgs(initialMessage, userArgs) {
      if (!initialMessage) return [...userArgs];
      return [initialMessage, ...userArgs];
    },
  };
}

export function resolveAgentLauncher(kind: QueueAgentKind): AgentLauncher {
  return positionalSeedLauncher(kind);
}
