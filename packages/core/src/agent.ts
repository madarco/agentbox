import type { AgentKind } from './types.js';

export interface AgentLauncher {
  readonly kind: AgentKind;
  buildArgs(initialMessage: string, userArgs: string[]): string[];
}

const claudeCodeLauncher: AgentLauncher = {
  kind: 'claude-code',
  // claude treats its first positional argument as the seed user turn in
  // interactive mode (`claude "<message>"`), so we slot the initial message
  // ahead of any user-passed flags.
  buildArgs(initialMessage, userArgs) {
    if (!initialMessage) return [...userArgs];
    return [initialMessage, ...userArgs];
  },
};

// codex accepts a leading positional as the seed prompt — `codex "<message>"`
// drops the user into the TUI with that turn pre-submitted. Same shape as
// claude, so the launcher is structurally identical.
const codexLauncher: AgentLauncher = {
  kind: 'codex',
  buildArgs(initialMessage, userArgs) {
    if (!initialMessage) return [...userArgs];
    return [initialMessage, ...userArgs];
  },
};

// opencode also accepts a leading positional as the seed prompt — `opencode
// "<message>"` enters the TUI with that turn pre-submitted. Mirrors claude/codex.
const opencodeLauncher: AgentLauncher = {
  kind: 'opencode',
  buildArgs(initialMessage, userArgs) {
    if (!initialMessage) return [...userArgs];
    return [initialMessage, ...userArgs];
  },
};

export function resolveAgentLauncher(kind: AgentKind): AgentLauncher {
  if (kind === 'claude-code') return claudeCodeLauncher;
  if (kind === 'codex') return codexLauncher;
  if (kind === 'opencode') return opencodeLauncher;
  throw new Error(`unknown agent kind: ${String(kind)}`);
}
