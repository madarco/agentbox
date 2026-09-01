import { defineAgentModule, type AgentModule } from '@agentbox/cli-kit';
import { PI_LOGIN_SPEC } from './login.js';
import { piRuntime } from './runtime.js';
import { resolvePiTeleport } from './teleport.js';

/**
 * Pi's CLI module.
 *
 * The teleport resolver is present because the spec declares
 * `caps.teleport: 'full'`; `agent-module-table.test.ts` asserts the two agree,
 * so a resolver without the capability (or the reverse) fails.
 */
export const agentModule: AgentModule = defineAgentModule('pi', {
  login: PI_LOGIN_SPEC,
  runtime: piRuntime,
  teleport: ({ hostCwd, mode, log }) => resolvePiTeleport({ hostCwd, mode, log }),
});
