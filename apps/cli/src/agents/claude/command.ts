/**
 * `agentbox claude` — built here, described in the package.
 *
 * The DESCRIPTOR (`claudeCliSpec`) lives in `@agentbox/agent-claude/cli`, beside
 * codex's and opencode's. It stayed in this folder longer than theirs because
 * claude is the only agent with hooks, and those hooks reached UP into the app —
 * the setup wizard, `runPrepare`, `providerForBox`, the clipboard helpers. A
 * package importing those would have closed an `apps/cli -> package -> apps/cli`
 * cycle, so the descriptor could not move until they were passed IN instead
 * (`AgentHostServices`, and the `clipboard` argument to `attachExtras`).
 *
 * The commander tree is still built here, for the same reason it is for the
 * other three: `buildAgentCommand`'s closure is the whole create/attach
 * pipeline, which has no business moving into an agent package.
 */
import { claudeCliSpec } from '@agentbox/agent-claude/cli';
import { buildAgentCommand } from '../command/factory.js';

const { command, attachWrapped } = buildAgentCommand(claudeCliSpec);

export const claudeCommand = command;
export const attachClaudeWrapped = attachWrapped;
