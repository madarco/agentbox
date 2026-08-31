/**
 * Codex's CLI surface.
 *
 * A separate entry from the package root: the root is the docker/cloud
 * behaviour that `sandbox-docker` and `sandbox-cloud` receive, and it must stay
 * importable by things that have no business pulling in commander and the
 * prompt stack. Only the CLI imports this one.
 */
export { codexCliSpec } from './cli-spec.js';
export { agentModule } from './module.js';
export { codexRuntime } from './runtime.js';
export { CODEX_LOGIN_SPEC, extractCodexUserCode } from './login.js';
export { codexLoginBinding } from './login-binding.js';
export { codexAuthAvailable } from './host-creds.js';
export { resolveCodexTeleport } from './teleport.js';

export {
  installCodexPlugin,
  upsertCodexPluginEnable,
  marketplaceSource,
  codexHomeDir,
  codexConfigPath,
  codexPluginEnableTable,
  type InstallCodexOptions,
  type InstallCodexResult,
  type CodexEnableStatus,
  type CodexEnableResult,
} from '../install-plugin.js';
