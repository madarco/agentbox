/**
 * OpenCode's CLI surface. A second entry point, so the package root stays
 * importable without commander and the prompt stack.
 */
export { opencodeCliSpec } from './cli-spec.js';
export { agentModule } from './module.js';
export { opencodeRuntime } from './runtime.js';
export { OPENCODE_LOGIN_SPEC } from './login.js';
export { opencodeLoginBinding } from './login-binding.js';
export { opencodeAuthAvailable } from './host-creds.js';
