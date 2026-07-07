export {
  STATE_DIR,
  STATE_FILE,
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  mutateState,
  readState,
  recordBox,
  recordBoxSsh,
  recordLastAgent,
  removeBoxRecord,
  reserveProjectIndex,
  resolveBoxRef,
  setBoxDisplayName,
  writeState,
} from './state.js';
export {
  detectGitRepos,
  GitWorktreeError,
  pickFreshBranch,
  type DetectedGitRepo,
} from './git-detect.js';
export { hostOpenCommand } from './host-open.js';
export {
  agentboxSshConfigPath,
  agentboxAliasFor,
  ensureSshInclude,
  syncAgentboxSshConfig,
  hasUnmanagedHostConflict,
  parseSshTarget,
  readAgentboxSshAlias,
  type SshAliasOptions,
  type SshTarget,
} from './ssh-config.js';
export {
  resolveCloudSshTarget,
  ensureCloudSshAlias,
  autoWriteSshConfig,
  type CloudSshAlias,
  type CloudSshOptions,
} from './cloud-ssh.js';
export {
  BOX_WORKSPACE,
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  boxRestartService,
  boxRestartServices,
  boxServicesStatusRaw,
  restartServiceArgv,
  scratchBranchName,
  servicesStatusArgv,
  type BoxGitDeps,
  type HostInitiatedArgs,
} from './box-git.js';
export {
  errSummary,
  firstLine,
  type CheckResult,
  type CheckStatus,
  type CredSetResult,
  type CredStatusSummary,
  type ProviderModule,
} from './doctor.js';
export { maskSecret, secretsEnvPath, writeManagedSecrets } from './secrets.js';
export {
  PLUGINS_FILE,
  SUPPORTED_SDK_API_VERSIONS,
  isSupportedApiVersion,
  readPluginRegistry,
  readPluginRegistrySync,
  addPluginRecord,
  removePluginRecord,
  pluginProviderNames,
  pluginForProvider,
  type PluginRecord,
  type PluginsFile,
} from './plugin-registry.js';
export {
  carryPlaceholderContext,
  renderCarryEntries,
  type CarryBoxContext,
} from './carry-render.js';
export * from './sync/index.js';
export {
  claudeInstallFingerprint,
  computeContextSha256,
  DOCKER_CONTEXT_FILE_MAP,
  preparedStatePathFor,
  readCliStamp,
  readPreparedStateRaw,
  resolveContextFilesFrom,
  sha256OfFile,
  shortFingerprint,
  writePreparedStateRaw,
  type CliStamp,
  type ContextFile,
  type PreparedBaseSnapshot,
  type PreparedProviderKind,
} from './prepared-state.js';
