/**
 * `agentbox pi` — Pi's command.
 *
 * A shim, not a clone: the descriptor, the runtime and the module all come from
 * `@agentbox/agent-pi/cli`. It exists only because the two dispatch tables need
 * literal, statically-resolvable import specifiers.
 */
import { piCliSpec } from '@agentbox/agent-pi/cli';
import { buildAgentCommand } from '../command/factory.js';

const { command, attachWrapped } = buildAgentCommand(piCliSpec);

export const piCommand = command;
export const attachPiWrapped = attachWrapped;
