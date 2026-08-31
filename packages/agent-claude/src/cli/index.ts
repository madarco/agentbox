/**
 * Claude's CLI surface.
 *
 * NOT here, deliberately: the `AgentCliSpec` descriptor. Claude is the only
 * agent with `hooks` — base-freshness checks, `runPrepare`, the setup wizard,
 * plan teleport, clipboard paste — and codex and opencode have none. Those are
 * the CREATE PIPELINE's optional steps that only claude happens to be wired
 * for, not claude's own behaviour, so packaging them here would file app
 * orchestration under an agent. They stay in
 * `apps/cli/src/agents/claude/command.ts` until they are generalized onto the
 * hook contract for every agent.
 */
export { claudeRuntime } from './runtime.js';
export { claudeCliSpec } from './cli-spec.js';
export { agentModule } from './module.js';
export { CLAUDE_LOGIN_SPEC, extractOAuthUrl } from './login.js';
export { claudeLoginBinding } from './login-binding.js';
export { claudeAuthAvailable, claudeCredStatus } from './host-creds.js';
export { resolveClaudeAuth, readAuthFile, AUTH_FILE, type AuthFile } from './auth.js';
export { resolveClaudeCredHealth } from './cred-health.js';
export { runClaudeLogin } from './login-run.js';
export {
  selectLoginMode,
  loginRootDir,
  loginSessionDir,
  writeLoginRequest,
  readLoginRequest,
  writeLoginState,
  readLoginState,
  writeLoginCode,
  takeLoginCode,
  pidAlive,
  listSessions,
  findPendingSession,
  findLiveSession,
  cleanupStaleSessions,
  type LoginPhase,
  type LoginState,
  type LoginRequest,
  type LoginMode,
} from './login-session.js';
export { addClaudeLoginOptions, runClaudeLoginCommand } from './login-command.js';
export { resolveClaudeTeleport } from './teleport.js';
