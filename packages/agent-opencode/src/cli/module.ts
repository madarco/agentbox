import { defineAgentModule, type AgentModule } from '@agentbox/cli-kit';
import { OPENCODE_LOGIN_SPEC } from './login.js';
import { opencodeRuntime } from './runtime.js';

// No `teleport`: opencode declares `caps.teleport: 'stub'` in the registry, and
// `prepareTeleport` refuses on that capability with the reason the spec carries.
export const agentModule: AgentModule = defineAgentModule('opencode', {
  login: OPENCODE_LOGIN_SPEC,
  runtime: opencodeRuntime,
});
