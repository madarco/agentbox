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
export { AGENT_SYNC_SPECS, resolveAgentSpec, agentIds } from './registry.js';
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
  pullCodexConfigViaTransport,
  pullOpencodeConfigViaTransport,
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
} from './agent-pull.js';
export type {
  AgentId,
  AgentSyncSpec,
  AgentPathMap,
  AgentCredential,
  AgentCapabilities,
} from './agents/types.js';
export { makeSyncContext, type SyncContext, type SyncContextInit } from './context.js';
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
  hostClaudeBackupExpired,
  hostBackupHasCredentials,
  extractCredentials,
  SEED_MARKER,
  type CredentialAgentKind,
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
  stageClaudeStaticForUpload,
  stageClaudeJsonOnlyForUpload,
  stageClaudeCredentialsForUpload,
  stageCodexStaticForUpload,
  stageCodexCredentialsForUpload,
  stageAgentsStaticForUpload,
  stageOpencodeStaticForUpload,
  stageOpencodeCredentialsForUpload,
  stageOpencodeStateForUpload,
  stageAllAgentStatic,
  type AgentStaticStage,
  type StageClaudeOptions,
  type StageCodexOptions,
  type StageOpencodeOptions,
  type StageResult,
} from './host-stage.js';
export {
  filterHostHooks,
  isHostPathHookCommand,
  setInstallMethodNative,
  addProjectAlias,
  trustWorkspace,
  type HookFilterResult,
  type SetInstallMethodNativeResult,
  type AddProjectAliasResult,
  type TrustWorkspaceResult,
} from './claude-hooks-filter.js';
export {
  sanitizeCodexConfigForBox,
  isHostOnlyPath,
  BOX_WORKSPACE,
  MINIMAL_TRUSTED_CODEX_CONFIG,
  type SanitizeCodexConfigResult,
} from './codex-config.js';
