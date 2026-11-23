export {
  STATE_DIR,
  STATE_FILE,
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  mutateState,
  readState,
  recordBox,
  clearBoxPortlessWebAlias,
  recordBoxSsh,
  recordAgentAdded,
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
export { hostOpenCommand, openOnHost } from './host-open.js';
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
export {
  EXPOSED_HUB_PROFILE,
  buildExposedHubEnv,
  parseEnvFileBody,
  scrubControlPlaneHubEnv,
} from './hub-expose.js';
export {
  applyDeviceCredentialEnv,
  deviceCredentialPath,
  deviceTokenFor,
  hubBearerFor,
  isDeviceToken,
  normalizeHubUrl,
  readDeviceCredential,
  removeDeviceCredential,
  writeDeviceCredential,
  type DeviceCredential,
} from './hub-device.js';
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
  staticInboundSources,
  describeInbound,
} from './inbound.js';
export {
  detectEgressIp,
  detectEgressCidr,
  detectEgressIpv6,
  cidrKey,
  expandIpv6,
  getOverIpv4,
  getOverIpv6,
  ipv6Prefix64,
  isIpv4,
  type DetectEgressIpOptions,
  type EgressProbeGet,
  type ProbeResponse,
} from './egress-ip.js';
export {
  ADMIN_DEVICE_KEY,
  DEVICE_ALLOWLIST_CAP,
  FIREWALL_PROVIDERS,
  firewallBlockedHint,
  repairOutcome,
  LEGACY_DEVICE_KEY,
  ipv4Cidrs,
  localMachineLabel,
  allowedSourcesOf,
  createTimeSelf,
  detectDeviceCidrs,
  deviceEntryNeedsUpdate,
  isControlBoxProcess,
  isOpenCidr,
  legacyEntryFor,
  normalizeDecoded,
  withInboundPolicy,
  localMachineKey,
  sanitizeDeviceKey,
  selfDeviceEntry,
  upsertDeviceEntry,
  type DeviceAllowEntry,
} from './device-allowlist.js';
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
  boxGitCurrentBranch,
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
export {
  clonePerBoxCarryRefusal,
  withPerBoxCarry,
  perBoxCarrySrc,
  resolvePerBoxCarry,
  type MissingPerBoxCarry,
  type PerBoxCarryContext,
  type PerBoxCarryResolution,
} from './per-box-carry.js';
export {
  modelAuthIngestArgv,
  runModelAuthIngest,
  type IngestExecResult,
  type ModelAuthIngestResult,
} from './model-auth-ingest.js';
export {
  agentSourceIds,
  borrowedCredentialCarry,
  envSourceKeys,
  resolveModelAuthIngest,
  resolveModelAuthSources,
} from './borrowed-credentials.js';
export {
  LLM_SPLIT_PROXY_PORT,
  LLM_SPLIT_PROXY_SCRIPT,
  isValidLlmProxyUpstream,
  llmProxyLaunchPreamble,
  resolveLlmProxyRecord,
  allAgentLlmHosts,
  llmProxyListenerEnabled,
  type LlmProxyConfig,
} from './llm-split-proxy.js';
export * from './sync/index.js';
export * from './sync/agent-pull-module.js';
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
export { checkoutEntriesFor } from './checkout-entries.js';
export {
  boxNameBasisFromOriginUrl,
  deriveRepoLabel,
  CP_WORKER_CLONE_PREFIX,
  HUB_WORKER_CLONE_PREFIX,
  isEphemeralWorkerClone,
  isHubWorkerClone,
  custodySlugCandidates,
  legacyProjectSlugFromOriginUrl,
  ownerRepoFromOriginUrl,
  projectSlugAtEdge,
  projectSlugFromOriginUrl,
  registrationOrigin,
  repoKeyAtEdge,
  type RegistrationOrigin,
  type RequesterOrigin,
} from './project-slug.js';

// ── Create-time host-boundary gates ──
// Each takes a `PromptAsker` rather than a prompt library, so the CLI, the hub's
// preflight and a replayed answer map all drive the same gate. See
// `packages/core/src/prompt.ts` for the schema every front-end renders.
export {
  buildCarryPrompt,
  CARRY_GRANT_TOPIC,
  CARRY_NON_INTERACTIVE_HINT,
  CARRY_TOPIC,
  carryGrantId,
  renderCarryTable,
  runCarryGate,
  toFileRow,
  type CarryDecision,
  type CarryGateArgs,
  type CarryGateResult,
} from './prompts/carry-gate.js';
export { resolveCarry, type ResolveOptions, type ResolveResult } from './prompts/carry-resolve.js';
export {
  DEFAULT_CP_EXCLUDES,
  effectiveExcludes,
  fmtBytes,
  isPathExcluded,
  measureCopy,
  toTarExcludes,
} from './prompts/dir-breakdown.js';
export {
  buildModelAuthPrompt,
  listAvailableSources,
  MODEL_AUTH_NONE,
  MODEL_AUTH_SETTING,
  MODEL_AUTH_TOPIC,
  parseModelAuthValue,
  resolveModelAuth,
  type AvailableSource,
  type ModelAuthGateArgs,
} from './prompts/model-auth-gate.js';
export { AGENT_SESSION_ENV_VARS, scrubAgentSessionEnv } from './agent-session-env.js';
export {
  ensurePtyDir,
  listPtySessions,
  newPtyRunId,
  newPtyToken,
  ptyDir,
  ptyLogPath,
  ptyMetaPath,
  ptySocketPath,
  readPtyMeta,
  removePtySession,
  writePtyMeta,
} from './pty-session.js';
export type { PtySessionMeta } from './pty-session.js';
export {
  ACCOUNTS_FILE,
  AccountsFileError,
  accountProblem,
  decodePastedSecret,
  encodePastedSecret,
  findLegacyAccountSlots,
  pastedSecretProblem,
  resolveLoginAccount,
  readAccounts,
  readAccountSecret,
  removeAccount,
  upsertAccount,
  writeAccountSecret,
} from './llm-accounts.js';
export type {
  AccountStoreOptions,
  LoginAccountRequest,
  PastedAccountSecret,
  WriteAccountSecretResult,
} from './llm-accounts.js';
// The skills library's PC-side modules (discovery, normalization, secret scan)
// and the skills digest cloud bases fold into their fingerprint.
export { LOCAL_SKILL_DIRS, discoverLocalSkills, readLocalSkill } from './skills/discover.js';
export type { LocalSkill } from './skills/discover.js';
export { parseSkillFrontmatter } from './skills/frontmatter.js';
export type { SkillFrontmatter } from './skills/frontmatter.js';
export { isSecretFileName, scanSkillFiles, shannonEntropy } from './skills/scan.js';
export type { SecretFinding } from './skills/scan.js';
export { readSkillTree, SkillTooLargeError, treeHash } from './skills/tree.js';
export { assertSafePath, readTar, SkillTarError, writeTar } from './skills/tar.js';
export type { TarFile } from './skills/tar.js';
export type { SkillFile, SkillTree } from './skills/tree.js';
export {
  authoredTreeHash,
  bakeSkillsStamp,
  isLibraryEligible,
  localSkillsDigest,
  resetSkillsDigestMemo,
  skillsDigest,
  skillsMatchForSkip,
  skillsStaleness,
} from './skills/digest.js';
export type { SkillsStamp } from './skills/digest.js';
export {
  accountEnvPolicy,
  applyAccountEnv,
  boxAccount,
  boxesOnAccount,
  NO_ACCOUNT_ENV,
  parseAccountFlags,
  resolveBoxAccounts,
  type AccountEnvPolicy,
  type ResolvedBoxAccounts,
} from './account-selection.js';
