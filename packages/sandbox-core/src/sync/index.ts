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
