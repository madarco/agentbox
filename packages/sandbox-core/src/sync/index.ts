/**
 * `@agentbox/sandbox-core`'s `sync/` layer — the provider-neutral, fs/execa-
 * bearing implementation of the sync contracts declared in `@agentbox/core`.
 * The per-tool registry, concern modules (git/env/files/credentials/skills/
 * dynamic), and the data-driven driver land here across the refactor phases.
 *
 * Today it exports the parity net used to golden-test each concern as it is
 * migrated onto the `SyncTransport` seam.
 */

export {
  makeRecordingTransport,
  type RecordingSyncTransport,
  type RecordingTransportOptions,
  type RecordedOp,
} from './recording-transport.js';
export {
  AGENT_SYNC_SPECS,
  resolveAgentSpec,
  agentIds,
  isRuntimeAgent,
  agentTuiEnv,
  findAgentSpec,
} from './registry.js';
export {
  mergeInstalledPlugins,
  mergeKnownMarketplaces,
  pickNewItems,
  referencedPluginVersionKeys,
  PULL_CATEGORIES,
  SKILL_EXCLUDE_PREFIXES,
  CONTAINER_PLUGINS_PREFIX,
  type MergeResult,
  type PullCategory,
} from './claude-pull.js';
export {
  claudeInventoryScript,
  parseClaudeInventory,
  computeClaudePullPlan,
  writeClaudeMergedRegistries,
  pullClaudeExtrasViaTransport,
  pullFlatConfigViaTransport,
  flatInventoryScript,
  parseFlatInventory,
  CLAUDE_PULL_DIR_CATEGORIES,
  CODEX_PULL_ITEMS,
  OPENCODE_PULL_DATA_ITEMS,
  OPENCODE_PULL_CONFIG_ITEMS,
  CLAUDE_BOX_CONFIG_DIR,
  CODEX_BOX_CONFIG_DIR,
  OPENCODE_BOX_DATA_DIR,
  type ClaudeInventory,
  type ClaudePullPlan,
  type PullClaudeResult,
  type FlatInventoryEntry,
  agentBoxDir,
} from './agent-pull.js';
export {
  buildAgentDescriptors,
  type AgentDescriptor,
  type AgentDescriptorPayload,
  type AgentWatchDescriptor,
} from './agent-descriptor.js';
export {
  agentBoxConfigDir,
  makeStagingDir,
  removeStagingDir,
  stageItemsViaTransport,
  transportSettingsTarget,
  propagateStagedSettings,
  planPropagateTargets,
  type StagedItem,
  type StagedSettings,
  type SettingsTarget,
  type PropagateTargetResult,
  type PropagateBoxLike,
  type PropagatePlan,
} from './agent-propagate.js';
// The agent spec contract lives in `@agentbox/core` (the zero-internal-dep leaf)
// so an agent package can declare its own row without importing anything that
// imports it back. Re-exported here because ~40 call sites already reach for it
// through `@agentbox/sandbox-core`.
export type {
  AgentId,
  AgentSyncSpec,
  AgentPathMap,
  AgentCredential,
  AgentCapabilities,
  AgentInstall,
  AgentInstallRecipe,
  AgentSeedSpec,
} from '@agentbox/core';
export { resolveAgentInstall } from '@agentbox/core';
export {
  agentSeedPlacements,
  buildAgentSeedScript,
  parseSeedMarkers,
  planAgentSeeds,
  AGENT_SEED_MARKER,
  type AgentSeedPlacement,
} from './agent-seed.js';
export { makeSyncContext, type SyncContext, type SyncContextInit } from './context.js';
export {
  ensureAgentInstalled,
  AgentInstallError,
  renderInstallRecipe,
  renderPackageInstall,
  renderAgentSettingEnv,
  type EnsureAgentInstalledResult,
} from './concerns/install.js';
export {
  pushEnvFiles,
  scanHostEnvFiles,
  buildHostEnvFindArgs,
  DEFAULT_ENV_PATTERNS,
  ENV_PRUNE_DIRS,
  type PushEnvFilesResult,
} from './concerns/env.js';
export {
  planCarryEntry,
  BOX_HOME,
  dirnameUnix,
  basenameUnix,
  type CarryPlan,
} from './concerns/files.js';
export {
  encodeClaudeProjectsKey,
  resolveClaudeMemoryDir,
  BOX_CLAUDE_PROJECT_DIR,
} from './agents/claude/paths.js';
export { findUnsyncableSymlinks } from './host-links.js';
export {
  seedAgentsVolume,
  type SeedAgentsVolumeArgs,
  type SeedAgentsVolumeResult,
} from './concerns/skills.js';
export {
  isRealAgentCredential,
  hostBackupHasCredentials,
  extractCredentials,
  parseCredentialsUpdate,
  oauthExpiresAt,
  oauthRefreshExpiresAt,
  shouldAcceptCredentialUpdate,
  writeCredentialBackup,
  readCredentialBackup,
  pushCredentialToBox,
  resolveHostCredential,
  SEED_MARKER,
  type CredentialAgentKind,
  type CredentialsUpdate,
  type ExtractCredentialsOptions,
} from './concerns/credentials.js';
export {
  classifyUntrackedOverlay,
  makeHostGitPorts,
  NON_REGULAR_TOKEN,
  resyncWorkspace,
} from './concerns/git.js';
export {
  BOX_WORKFLOWS_DIR,
  BOX_MEMORY_DIR,
  BOX_DYNAMIC_SYNC_MANIFEST,
  buildHostSyncManifest,
  computeSyncDelta,
  stageDynamicSyncTarball,
  type DynamicSyncManifest,
  type DynamicSyncSet,
  type DynamicSyncSetName,
  type DynamicSyncDelta,
  type DynamicSyncUpload,
  type DynamicSyncDeletion,
  type HostSyncManifest,
  type StagedTarball,
} from './concerns/dynamic.js';
export {
  stageAgentsStaticForUpload,
  stageAgentStaticForUpload,
  AGENTS_STATIC_BOX_DIR,
  // Staging primitives. Exported so an agent package can build its OWN stager
  // when a copy of its declared paths is not enough (claude filters host-path
  // hooks, codex sanitizes config.toml) without re-implementing the rsync/tar
  // plumbing or the cleanup contract.
  pathExists,
  findBrokenSymlinks,
  mkStageDir,
  emptyResult,
  tarballFromDir,
  makeCleanup,
  stageSingleFileTarball,
  STAGE_WRITABLE_CHMOD,
  type AgentStaticStage,
  type StageResult,
} from './host-stage.js';
