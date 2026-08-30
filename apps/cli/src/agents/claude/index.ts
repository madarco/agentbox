import { defineAgentModule, type AgentModule } from '../index.js';
import { CLAUDE_LOGIN_SPEC } from './login.js';
import { resolveClaudeTeleport } from './teleport.js';

export const agentModule: AgentModule = defineAgentModule('claude', {
  login: CLAUDE_LOGIN_SPEC,
  teleport: resolveClaudeTeleport,
});
