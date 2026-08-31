import { defineAgentModule, type AgentModule } from '@agentbox/cli-kit';
import { EXAMPLE_LOGIN_SPEC } from './login.js';
import { exampleRuntime } from './runtime.js';

/**
 * The demo agent's CLI module.
 *
 * No `teleport`, and that is checked rather than assumed: the spec declares
 * `caps.teleport: 'stub'`, and `agent-module-table.test.ts` asserts the two
 * agree — a module with a teleport resolver and a stub capability, or the
 * reverse, fails.
 */
export const agentModule: AgentModule = defineAgentModule('example', {
  login: EXAMPLE_LOGIN_SPEC,
  runtime: exampleRuntime,
});
