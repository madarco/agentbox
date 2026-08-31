/**
 * `agentbox opencode` — built here, described in the package.
 * See `../codex/command.ts` for why the factory stays in the app.
 */
import { opencodeCliSpec } from '@agentbox/agent-opencode/cli';
import { buildAgentCommand } from '../command/factory.js';

const { command, attachWrapped } = buildAgentCommand(opencodeCliSpec);

export const opencodeCommand = command;
export const attachOpencodeWrapped = attachWrapped;
