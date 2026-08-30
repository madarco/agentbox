import { defineAgentModule, type AgentModule } from '../index.js';
import { CODEX_LOGIN_SPEC } from './login.js';
import { resolveCodexTeleport } from './teleport.js';

export const agentModule: AgentModule = defineAgentModule('codex', {
  login: CODEX_LOGIN_SPEC,
  teleport: resolveCodexTeleport,
});
