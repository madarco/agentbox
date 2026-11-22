/**
 * Incremental host -> box seed of Claude Code's *dynamic* config (global
 * `~/.claude/workflows/` scripts + the current project's `memory/` tree).
 *
 * The logic moved to the shared sync layer (`@agentbox/sandbox-core`'s
 * `sync/concerns/dynamic`) so the cloud `seedDynamicConfig` reuses it without
 * importing this package — the dependency leak the sync refactor closes. This
 * module re-exports it verbatim so existing `@agentbox/sandbox-docker` import
 * sites (the docker index, the dynamic-sync test) keep working.
 */

export {
  BOX_WORKFLOWS_DIR,
  BOX_DYNAMIC_SYNC_MANIFEST,
  BOX_MEMORY_DIR,
  buildHostSyncManifest,
  computeSyncDelta,
  stageDynamicSyncTarball,
  type DynamicSyncSetName,
  type DynamicSyncSet,
  type DynamicSyncManifest,
  type HostSyncManifest,
  type DynamicSyncUpload,
  type DynamicSyncDeletion,
  type DynamicSyncDelta,
  type StagedTarball,
} from '@agentbox/sandbox-core';
