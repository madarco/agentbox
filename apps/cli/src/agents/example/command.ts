/**
 * `agentbox example` — the demo agent's command.
 *
 * Hidden on its spec row, so it never shows in `--help` or a picker. It exists
 * so the CLI's tables have a fourth arm that nothing in `apps/cli` had to be
 * taught about: the descriptor, the runtime and the module all come from
 * `@agentbox/agent-example/cli`.
 */
import { exampleCliSpec } from '@agentbox/agent-example/cli';
import { buildAgentCommand } from '../command/factory.js';

const { command, attachWrapped } = buildAgentCommand(exampleCliSpec);

export const exampleCommand = command;
export const attachExampleWrapped = attachWrapped;
