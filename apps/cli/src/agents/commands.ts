/**
 * The EAGER half of the agent tables: the commander `Command` each agent
 * registers, plus its wrapped-attach entry point.
 *
 * Separate from `AGENT_MODULES` in `./index.ts` on purpose. That table is lazy
 * and is loaded on paths — session teleport, agent-session restore — that must
 * not pull three commands' worth of imports; this one is eager because
 * `apps/cli/src/index.ts` has to hand commander a real `Command` before it
 * parses argv, and it already imported all three command modules at startup
 * before this table existed.
 *
 * Literal `import` specifiers, same constraint as `./index.ts`: the CLI's tsup
 * build has to resolve each one statically or the published bundle
 * `MODULE_NOT_FOUND`s at run time while the dev tree stays green.
 *
 * NOT exhaustive by type — `AgentId` is an open string. `agent-command-coverage`
 * asserts these keys against `agentIds()`.
 */
import type { Command } from 'commander';
import type { AttachOpenIn } from '@agentbox/config';
import type { BoxRecord } from '@agentbox/sandbox-docker';
import { claudeCommand, attachClaudeWrapped } from '../commands/claude.js';
import { codexCommand, attachCodexWrapped } from './codex/command.js';
import { opencodeCommand, attachOpencodeWrapped } from './opencode/command.js';

/**
 * Attach to a box's agent tmux session through the wrapped-pty footer, then
 * exit with the inner pty's code. Never returns.
 */
export type AttachWrapped = (
  box: BoxRecord,
  sessionName: string | undefined,
  reattach: string,
  onError?: (msg: string) => void,
  openIn?: AttachOpenIn,
) => Promise<never>;

export interface AgentCommandEntry {
  command: Command;
  attachWrapped: AttachWrapped;
}

const AGENT_COMMANDS: Record<string, AgentCommandEntry> = {
  claude: { command: claudeCommand, attachWrapped: attachClaudeWrapped },
  codex: { command: codexCommand, attachWrapped: attachCodexWrapped },
  opencode: { command: opencodeCommand, attachWrapped: attachOpencodeWrapped },
};

/** Agent ids with a command in this build. */
export function agentCommandIds(): string[] {
  return Object.keys(AGENT_COMMANDS);
}

/** Every agent's command, in table order — what `index.ts` registers. */
export function agentCommands(): Command[] {
  return Object.values(AGENT_COMMANDS).map((e) => e.command);
}

/**
 * One agent's command + attach entry point, or undefined when the registry
 * knows the agent but this table does not. Callers that cannot proceed without
 * it should say so by name rather than dereferencing undefined.
 */
export function agentCommandEntry(id: string): AgentCommandEntry | undefined {
  return AGENT_COMMANDS[id];
}
