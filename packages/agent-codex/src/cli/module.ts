import { defineAgentModule, type AgentModule } from '@agentbox/cli-kit';
import { CODEX_LOGIN_SPEC } from './login.js';
import { codexRuntime } from './runtime.js';
import { resolveCodexTeleport } from './teleport.js';

export const agentModule: AgentModule = defineAgentModule('codex', {
  login: CODEX_LOGIN_SPEC,
  runtime: codexRuntime,
  teleport: resolveCodexTeleport,
});
