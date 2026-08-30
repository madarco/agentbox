import { defineAgentModule, type AgentModule } from '../index.js';
import { CLAUDE_LOGIN_SPEC } from './login.js';
import { claudeRuntime } from './runtime.js';
import { resolveClaudeTeleport } from './teleport.js';

export const agentModule: AgentModule = defineAgentModule('claude', {
  login: CLAUDE_LOGIN_SPEC,
  runtime: claudeRuntime,
  teleport: resolveClaudeTeleport,
});
