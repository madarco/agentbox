import type { SandboxProvider } from '@agentbox/core';

export {
  attachClaudeSession,
  formatDetachNotice,
  buildClaudeAttachArgv,
  buildClaudeDashboardAttachArgv,
  buildClaudeLoginRunArgv,
  buildClaudeMounts,
  buildTmuxSessionArgs,
  buildShellArgv,
  ClaudeSessionError,
  claudeSessionInfo,
  CONTAINER_USER,
  DEFAULT_CLAUDE_SESSION,
  ensureClaudeVolume,
  pullClaudeExtras,
  rebuildPluginNativeDeps,
  resolveClaudeVolume,
  runInteractiveClaudeLogin,
  scanPluginCacheForRebuild,
  seedSetupSkillIntoVolume,
  SHARED_CLAUDE_VOLUME,
  startClaudeSession,
  warmUpClaudeCredentials,
  type ClaudeConfigSpec,
  type ClaudeMountResult,
  type ClaudeSessionInfo,
  type EnsureClaudeVolumeOptions,
  type EnsureClaudeVolumeResult,
  type PullClaudeOptions,
  type PullClaudeResult,
  type RebuildPluginNativeDepsResult,
  type StartClaudeSessionOptions,
  type WarmUpClaudeResult,
} from './claude.js';
export {
  CREDENTIALS_BACKUP_FILE,
  hostBackupHasCredentials,
  parseSyncResult,
  syncClaudeCredentials,
  type CredentialSyncDirection,
  type SyncClaudeCredentialsResult,
} from './claude-credentials.js';
export { createBox, type CreateBoxOptions, type CreatedBox } from './create.js';
export {
  agentboxHomeBytes,
  allCheckpointImagesBytes,
  boxResourceStats,
  parseDockerSize,
  projectCheckpointImageBytes,
  volumeSizeBytes,
} from './stats.js';
export { getBoxEndpoints, type BoxEndpoint, type BoxEndpoints } from './endpoints.js';
export { execInBox, removeImage, type DockerExecResult } from './docker.js';
export {
  detectGitRepos,
  GitWorktreeError,
  pickFreshBranch,
  type DetectedGitRepo,
} from './git-worktree.js';
export {
  bindWorktrees,
  collectRepoCarryOver,
  gitWorktreePathFor,
  removeInBoxWorktree,
  seedWorkspace,
  seedWorkspaceFromDir,
  WORKTREE_ROOT,
  type RepoCarryOver,
  type SeedWorkspaceOptions,
  type WorktreeBindSpec,
} from './in-box-git.js';
export { DEFAULT_BOX_IMAGE, ensureImage } from './image.js';
export {
  clearRelayNotice,
  DEFAULT_RELAY_PORT,
  ensureRelay,
  forgetBoxFromRelay,
  generateRelayToken,
  getRelayStatus,
  registerBoxWithRelay,
  rehydrateRelayRegistry,
  RELAY_CONTAINER_NAME,
  RELAY_IMAGE_REF,
  RELAY_NETWORK_NAME,
  setRelayNotice,
  stopRelay,
  type EnsureRelayOptions,
  type RegisterBoxArgs,
  type RelayEndpoint,
  type RelayStatus,
  type StopRelayResult,
} from './relay.js';
export { EXCLUDE_DIRS, SNAPSHOTS_ROOT, snapshotPathFor } from './snapshot.js';
export {
  CHECKPOINTS_ROOT,
  CHECKPOINT_IMAGE_PREFIX,
  CheckpointError,
  checkpointImageTag,
  computeNextCheckpointName,
  createCheckpoint,
  listAllCheckpointImages,
  listCheckpoints,
  projectCheckpointsDir,
  removeCheckpoint,
  resolveCheckpoint,
  type CheckpointInfo,
  type CheckpointManifest,
  type CheckpointType,
  type CreateCheckpointOptions,
} from './checkpoint.js';
export {
  STATE_DIR,
  STATE_FILE,
  allocateProjectIndex,
  autoPickProjectBox,
  findBox,
  readState,
  recordBox,
  removeBoxRecord,
  resolveBoxRef,
  type BoxRecord,
  type FindBoxResult,
  type GitWorktreeRecord,
  type StateFile,
} from './state.js';
export {
  attachedContainerUri,
  buildFlavorMounts,
  buildIdeMounts,
  buildVscodeMounts,
  cursorServerVolumeName,
  ensureAgentboxTasksFile,
  ensureIdeVolumes,
  ensureVscodeVolumes,
  ideProfile,
  IDE_FLAVORS,
  ideServerVolumeName,
  repairIdeOwnership,
  repairVscodeServerOwnership,
  SHARED_CURSOR_EXTENSIONS_VOLUME,
  SHARED_VSCODE_EXTENSIONS_VOLUME,
  vscodeServerVolumeName,
  type EnsureTasksFileResult,
  type IdeFlavor,
  type IdeMounts,
  type ServiceTailHint,
  type VscodeMounts,
} from './vscode.js';
export {
  BOXES_ROOT,
  boxRunDirFor,
  boxStatusPathFor,
  readBoxStatus,
  buildHostEnvFindArgs,
  CONTAINER_EXPORT_MERGED,
  copyHostEnvFilesToBox,
  copyHostFilesToBox,
  orbstackVolumePath,
  DEFAULT_ENV_PATTERNS,
  detectEngine,
  getDockerContext,
  ExportError,
  getHostPaths,
  openInFinder,
  pullToHost,
  refreshExport,
  scanHostEnvFiles,
  setEngineOverride,
  type DockerEngine,
  type HostPaths,
  type CopyHostEnvOptions,
  type CopyHostFilesOptions,
  type OpenOptions,
  type OpenResult,
  type PullOptions,
  type PullResult,
  type RefreshOptions,
  type RefreshResult,
} from './host-export.js';
export {
  detectPortless,
  installPortless,
  portlessBrowserEnv,
  portlessAlias,
  portlessUnalias,
  portlessGetUrl,
  portlessInstallHint,
  portlessStartHint,
  PORTLESS_PROXY_PORT,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  startPortlessProxy,
  type PortlessState,
} from './portless.js';
export {
  AmbiguousBoxError,
  BoxNotFoundError,
  destroyBox,
  getBoxHostPaths,
  inspectBox,
  listBoxes,
  openBoxInFinder,
  pauseBox,
  pruneBoxes,
  snapshotPresent,
  startBox,
  stopBox,
  unpauseBox,
  type DestroyOptions,
  type DestroyResult,
  type InspectedBox,
  type ListedBox,
  type OpenedBox,
  type PruneOptions,
  type PruneResult,
  type StartedBox,
} from './lifecycle.js';
export {
  buildVncUrls,
  generateVncPassword,
  launchVncDaemon,
  VNC_CONTAINER_PORT,
  type VncLaunchResult,
  type VncUrls,
} from './vnc.js';
export { browserSessionActive, ensureBoxBrowser, type BoxBrowserResult } from './browser.js';
export {
  allocateShellSessionName,
  buildShellSessionAttachArgv,
  DEFAULT_SHELL_SESSION,
  isShellSessionName,
  killShellSession,
  listShellSessions,
  parseShellSessionList,
  SHELL_SESSION_PREFIX,
  shellLabel,
  shellSessionInfo,
  shellSessionName,
  startShellSession,
  type ShellSessionInfo,
  type ShellSessionSummary,
  type StartShellSessionOptions,
} from './shell-session.js';
export {
  dockerVolumeName,
  launchDockerdDaemon,
  SHARED_DOCKER_CACHE_VOLUME,
  type DockerdLaunchResult,
} from './dockerd.js';

const notYet = (op: string): never => {
  throw new Error(`@agentbox/sandbox-docker: ${op} is not yet implemented`);
};

export const dockerProvider: SandboxProvider = {
  name: 'docker',
  async start(opts) {
    const { createBox } = await import('./create.js');
    const { record } = await createBox({
      workspacePath: opts.workspacePath,
      useSnapshot: false,
    });
    return {
      id: record.id,
      state: 'running',
      agent: opts.agent,
      workspacePath: record.workspacePath,
      createdAt: new Date(record.createdAt),
    };
  },
  async pause(id) {
    const { pauseBox } = await import('./lifecycle.js');
    await pauseBox(id);
  },
  async resume(id) {
    const { unpauseBox } = await import('./lifecycle.js');
    await unpauseBox(id);
  },
  async stop(id) {
    const { stopBox } = await import('./lifecycle.js');
    await stopBox(id);
  },
  async destroy(id) {
    const { destroyBox } = await import('./lifecycle.js');
    await destroyBox(id);
  },
  async list() {
    const { listBoxes } = await import('./lifecycle.js');
    const boxes = await listBoxes();
    return boxes.map((b) => ({
      id: b.id,
      state: b.state,
      agent: 'claude-code' as const,
      workspacePath: b.workspacePath,
      createdAt: new Date(b.createdAt),
    }));
  },
  async stats(id) {
    const { readState, findBox } = await import('./state.js');
    const { boxResourceStats } = await import('./stats.js');
    const found = findBox(id, await readState());
    if (found.kind !== 'ok') {
      throw new Error(`box not found: ${id}`);
    }
    return boxResourceStats(found.box);
  },
};

// notYet is no longer reachable from the public API. Keep it for now in case
// future provider methods need it before they're implemented.
void notYet;
