/** Public surface of the core sync contracts. Implementation lives in
 * `@agentbox/sandbox-core`'s `sync/` folder and the two provider packages. */

export type {
  SyncDirection,
  SyncTopology,
  SyncParty,
  SyncConcern,
  SyncState,
} from './types.js';
export type {
  SyncTransport,
  TransportCaps,
  PushOptions,
  VolumeHostSource,
  SyncExecOptions,
  SyncExecResult,
} from './transport.js';
export type { SyncAgentKind, QueueAgentKind } from './agent-kind.js';
export {
  SYNC_AGENT_KINDS,
  isSyncAgentKind,
  toSyncKind,
  toQueueKind,
  normalizeLastAgent,
} from './agent-kind.js';
export type { ConflictVerdict, ConflictPolicy, Reconciler } from './reconciler.js';
export type {
  WorkspaceResyncPorts,
  ResyncWorktree,
  ResyncExecResult,
  RepoResyncResult,
} from './workspace.js';
export type { SyncContext } from './context.js';
export type { ProviderSync, CarryApplyResult } from './provider-sync.js';
export { dryRunProviderSync, SYNC_DRYRUN_ENV } from './provider-sync.js';
export { resolveSyncTopology } from './topology.js';
export type { GitRpcParams } from './git-refs.js';
export type { DownloadKind } from './files.js';
export { parseDownloadKind, resolveHostPath } from './files.js';
export {
  SCRATCH_BRANCH_PREFIX,
  isScratchBranch,
  resolveRemote,
  resolveLandDest,
  landRefspec,
  upstreamRef,
  remoteTrackingRef,
  isResolvedBranch,
  sanitizeGitArgs,
} from './git-refs.js';
