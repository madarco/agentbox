import type { QueueAgentKind } from './sync/agent-kind.js';
import type { AgentSyncSpec } from './sync/agent-spec.js';

export interface AgentLauncher {
  readonly kind: QueueAgentKind;
  buildArgs(initialMessage: string, userArgs: string[]): string[];
}

/**
 * How an agent takes its seed user turn, read off its registry row:
 * `seedPromptFlag` absent means a leading positional (`claude "<msg>"`,
 * `codex "<msg>"`, `pi "<msg>"`); present means the prompt goes behind that
 * flag (`opencode --prompt "<msg>"`, whose positional is the project directory).
 *
 * Takes the spec rather than looking it up because this leaf cannot reach the
 * registry; a caller without one gets the positional shape.
 */
export function resolveAgentLauncher(
  kind: QueueAgentKind,
  spec?: Pick<AgentSyncSpec, 'seedPromptFlag'>,
): AgentLauncher {
  const flag = spec?.seedPromptFlag;
  return {
    kind,
    buildArgs(initialMessage, userArgs) {
      if (!initialMessage) return [...userArgs];
      if (!flag) return [initialMessage, ...userArgs];
      // `--prompt=<msg>` for a long flag: as a separate token, a prompt that
      // starts with `-` is parsed as flags and lost.
      return flag.startsWith('--')
        ? [`${flag}=${initialMessage}`, ...userArgs]
        : [flag, initialMessage, ...userArgs];
    },
  };
}
