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
import { isServiceAgent } from '@agentbox/core';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { claudeCommand, attachClaudeWrapped } from './claude/command.js';
import { codexCommand, attachCodexWrapped } from './codex/command.js';
import { opencodeCommand, attachOpencodeWrapped } from './opencode/command.js';
import { piCommand, attachPiWrapped } from './pi/command.js';
import { exampleCommand, attachExampleWrapped } from './example/command.js';
import { buildServiceAgentCommand } from './command/service-factory.js';

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
  /**
   * How `attach` hands the terminal to this agent's tmux session.
   *
   * OPTIONAL because a `caps.surface: 'service'` agent has no session to attach
   * to — it is a daemon the box's supervisor runs, and its command tree ends at
   * "ready + URL" (see `command/service-factory.ts`). Every TUI agent must still
   * have one; `agent-command-coverage.test.ts` asserts exactly that split, so
   * this being optional never becomes "some TUI agent forgot".
   */
  attachWrapped?: AttachWrapped;
}

/**
 * Service agents get their command from the shared service factory rather than
 * from a per-agent package: there is nothing tool-specific to write. The entry
 * is built here, off the registry row, so adding one is adding a registry row.
 */
function serviceAgentEntries(): Record<string, AgentCommandEntry> {
  const out: Record<string, AgentCommandEntry> = {};
  for (const spec of AGENT_SYNC_SPECS) {
    if (!isServiceAgent(spec) || !spec.service) continue;
    out[spec.id] = { command: buildServiceAgentCommand(spec) };
  }
  return out;
}

const AGENT_COMMANDS: Record<string, AgentCommandEntry> = {
  claude: { command: claudeCommand, attachWrapped: attachClaudeWrapped },
  codex: { command: codexCommand, attachWrapped: attachCodexWrapped },
  opencode: { command: opencodeCommand, attachWrapped: attachOpencodeWrapped },
  pi: { command: piCommand, attachWrapped: attachPiWrapped },
  example: { command: exampleCommand, attachWrapped: attachExampleWrapped },
  ...serviceAgentEntries(),
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
 * Agent ids whose command must not appear in `--help`.
 *
 * Straight off the registry's `hidden` flag: an agent that is hidden from
 * pickers and the bake list has no business showing up in the command list
 * either. The demo agent is the only one today, and without this it lands in
 * the grouped help's "Other" bucket — which `grouped --help` fails on, correctly.
 */
export function hiddenAgentCommandIds(): Set<string> {
  return new Set(AGENT_SYNC_SPECS.filter((s) => s.hidden).map((s) => s.id));
}

/**
 * One agent's command + attach entry point, or undefined when the registry
 * knows the agent but this table does not. Callers that cannot proceed without
 * it should say so by name rather than dereferencing undefined.
 */
export function agentCommandEntry(id: string): AgentCommandEntry | undefined {
  return AGENT_COMMANDS[id];
}
