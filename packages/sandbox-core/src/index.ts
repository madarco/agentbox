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
  controlPlaneDeployPath,
  AGENTBOX_HUB_SSH_ALIAS,
  ensureSshInclude,
  syncAgentboxSshConfig,
  hasUnmanagedHostConflict,
  parseSshTarget,
  readAgentboxSshAlias,
  type ControlPlaneDeployRecord,
  type HubDeploySource,
  type SshAliasOptions,
  type SshTarget,
} from './ssh-config.js';
export { EXPOSED_HUB_PROFILE, buildExposedHubEnv, parseEnvFileBody } from './hub-expose.js';
export {
  resolveCloudSshTarget,
  ensureCloudSshAlias,
  autoWriteSshConfig,
  type CloudSshAlias,
  type CloudSshOptions,
} from './cloud-ssh.js';
export { mintSshKey, type MintedSshKey } from './ssh-key.js';
export { resolveSshConfigTarget, type SshConfigTarget } from './ssh-config-probe.js';
export {
  scpDownload,
  scpUpload,
  sshDestination,
  sshExec,
  sshOptArgs,
  waitForSsh,
  type SshExecOptions,
  type SshExecResult,
  type SshTargetArgs,
} from './ssh-exec.js';
export {
  SshTunnelManager,
  controlSockPath,
  defaultBoxSshDir,
  boxSshNamespaceForProvider,
  boxSshDirForProvider,
  pickFreePort,
  type PortForward,
  type SshTunnelOpenOptions,
} from './ssh-tunnel.js';
export {
  OPEN_INBOUND_SOURCES,
  normalizeInboundCidr,
  parseInboundSpec,
  resolveInboundSources,
  describeInbound,
} from './inbound.js';
export {
  claudeSettingsPath,
  claudeSshEntryFor,
  pruneOrphanClaudeSshConfigs,
  removeClaudeSshConfigs,
  upsertClaudeSshConfig,
  type ClaudeSshConfigEntry,
} from './claude-app-config.js';
export {
  BOX_WORKSPACE,
  boxGitCheckout,
  boxGitNewBranch,
  boxGitPull,
  boxGitPush,
  boxGitPushHost,
  boxLogsArgv,
  boxLogsRaw,
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
  statusBadge,
  type CheckResult,
  type CheckStatus,
  type CredSetResult,
  type CredStatusSummary,
  type ProviderModule,
} from './doctor.js';
export { maskSecret, secretsEnvPath, writeManagedSecrets } from './secrets.js';
export {
  publishManagedCredentials,
  setCredentialPublisher,
  type CredentialPublisher,
} from './credential-publish.js';
export {
  fetchHealthz,
  killPid,
  pingHealthz,
  portIsOccupied,
  processAlive,
  resolveCliEntry,
  shouldReclaimForVersion,
  type HealthzBody,
  type RelayReuseHealth,
} from './hub-process.js';
export {
  FALLBACK_RELAY_PORT,
  isValidRelayPort,
  RELAY_PORT_ENV,
  relayPort,
  resetRelayPort,
  setRelayPort,
} from './relay-port.js';
export {
  ensureHub,
  getHubStatus,
  stopHub,
  resolveHubServer,
  hubRuntimeEnv,
  readHubToken,
  HUB_TOKEN_FILE,
  type EnsureHubOptions,
  type HubEndpoint,
  type HubStatus,
  type StopHubResult,
} from './hub-lifecycle.js';
export { setHubPortlessHooks, setHubDockerContext, type HubPortlessHooks } from './hub-hooks.js';
export {
  runDockerCredentialRefresh,
  setDockerCredentialRefresh,
  type DockerCredentialRefresher,
} from './credential-refresh.js';
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
  recordPluginDescriptor,
  PLUGINS_FILE_VERSION,
  type PluginRecord,
  type PluginsFile,
  type PluginsFileVersion,
} from './plugin-registry.js';
export {
  resolveProviderDescriptor,
  listProviderDescriptors,
  deriveDescriptor,
  ensureProviderDescriptor,
} from './provider-descriptor.js';
export {
  carryPlaceholderContext,
  renderCarryEntries,
  type CarryBoxContext,
} from './carry-render.js';
export * from './sync/index.js';
export {
  variantFingerprint,
  bakeSettingsFingerprintInput,
  type AgentSettingsMap,
  normalizeAgentSet,
  agentSetArg,
  computeContextManifest,
  computeContextSha256,
  diffFileManifests,
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
  type ContextManifest,
  type FileManifest,
  type FileManifestDiff,
  type PreparedBaseSnapshot,
  type PreparedProviderKind,
} from './prepared-state.js';
export {
  CLI_RUNTIME_DIR_ENV,
  RUNTIME_ROOT_ENV,
  resolveStagedRuntimeRoot,
  sharedRuntimeAssetPath,
  stagedRuntimeRootCandidates,
} from './runtime-root.js';

export { BOX_IMAGE_REGISTRY, registryRefForSha } from './box-registry.js';
export {
  boxNameBasisFromOriginUrl,
  deriveRepoLabel,
  HUB_WORKER_CLONE_PREFIX,
  isHubWorkerClone,
  ownerRepoFromOriginUrl,
  projectSlugFromOriginUrl,
} from './project-slug.js';
