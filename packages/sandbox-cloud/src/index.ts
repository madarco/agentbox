export {
  CLOUD_VNC_PORT,
  CLOUD_WEB_PROXY_PORT,
  CLOUD_WORKSPACE_DIR,
  createCloudProvider,
  emptyCloudStats,
  hostTermForCloud,
  renderInnerCommand,
  type CreateCloudProviderOptions,
} from './cloud-provider.js';
export {
  buildCloudAttachInnerCommand,
  startDetachedCloudAgent,
  startDetachedSession,
  verifyDetachedSession,
  type StartDetachedCloudAgentArgs,
} from './detached-agent.js';
export { kickCloudBootstrap, type KickCloudBootstrapArgs } from './bootstrap-launch.js';
export {
  registerBoxWithPlane,
  readGitOriginUrl,
  type RegisterBoxWithPlaneArgs,
} from './plane-register.js';
export { pushBoxSshToCustody, type PushBoxSshArgs } from './custody-ssh.js';
export { deadlineFetch, hostReachable, DEFAULT_REACHABLE_PROBE_MS } from './reachability.js';
export {
  preparedCustodyPath,
  pullPreparedFromCustody,
  pushPreparedToCustody,
  writePreparedToCustodyStore,
  type PreparedCustodyWriter,
  type PreparedRecord,
  type PreparedSyncTarget,
  type PullPreparedResult,
} from './prepared-sync.js';
export {
  adminCustodySink,
  applyProjectSeed,
  buildCarrySeed,
  buildProjectSeed,
  CarrySeedError,
  isCarrySeedError,
  pushProjectSeedToCustody,
  CARRY_SEED_ITEMS,
  DEFAULT_MAX_BLOB_BYTES,
  SEED_PUSH_MS,
  type ApplyProjectSeedResult,
  type CarrySeedSource,
  type CarrySeedManifest,
  type MaterializedCarryEntry,
  type SeedCustodySink,
  type SeedSource,
  type BuildProjectSeedArgs,
  type BuildProjectSeedResult,
  type PushProjectSeedArgs,
  type PushProjectSeedResult,
  type SeedItem,
  type SeedManifest,
  type SeedManifestFile,
} from './custody-seed.js';
export {
  seedCloudWorkspace,
  type SeedCloudWorkspaceArgs,
  type SeedCloudWorkspaceResult,
} from './sync/workspace-seed.js';
export {
  agentSpecsForCloud,
  ensureAgentHomeDirsOwned,
  ensureAgentsInstalledForCloud,
  ensureAgentVolumesForCloud,
  extractCloudAgentCredentials,
  reconcileAgentCredentials,
  reconcileAgentCredentialsViaTransport,
  seedAgentVolumesIfFresh,
  seedOpencodeModelState,
  type CloudAgentKind,
  type EnsureAgentVolumesResult,
  type ReconcileAgentCredentialsOptions,
  type SeedAgentVolumesOptions,
} from './sync/agent-credentials.js';
export {
  buildAgentStaticSeedCommands,
  seedAgentStaticIntoCloudBox,
  type SeedAgentStaticOptions,
  type SeedAgentStaticResult,
} from './sync/agent-static.js';
export {
  uploadEnvFiles,
  type UploadEnvFilesArgs,
  type UploadEnvFilesResult,
} from './sync/env-files.js';
export { createCloudSyncTransport, type CloudSyncTransportInit } from './sync/sync-transport.js';
export { makeCloudSync, type CloudSyncOptions } from './sync/cloud-sync.js';
export { seedDynamicConfig, type SeedDynamicConfigOptions } from './sync/dynamic-sync.js';
export { seedClaudeJsonAtCreate, type SeedClaudeJsonOptions } from './sync/claude-json-overlay.js';
export {
  seedGitIdentity,
  seedGitCredentials,
  type SeedGitIdentityOptions,
} from './sync/git-identity.js';
export { bashScript, quoteShellArg, quoteShellArgv } from './shell.js';
export { openWebAppOnVncScreen, type CloudVncBrowserResult } from './vnc-browser.js';
export {
  makeMockCloudBackend,
  type MockCloudBackend,
  type MockCloudBackendOptions,
} from './mock-backend.js';
export {
  downloadFromCloudBox,
  pullCloudDirContents,
  uploadToCloudBox,
  type CloudCpResult,
} from './cloud-cp.js';
export {
  CLOUD_CHECKPOINTS_ROOT,
  CLOUD_SNAPSHOT_NAME_PREFIX,
  baseFreshnessFromFingerprints,
  cloudSnapshotName,
  currentCloudBaseFingerprint,
  listAllCloudCheckpoints,
  listCloudBackendDirs,
  listCloudCheckpoints,
  probeCloudCheckpoint,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
  type BaseStatus,
  type CloudCheckpointInfo,
  type CloudCheckpointManifest,
  type CloudCheckpointProjectGroup,
  type WriteCloudManifestFields,
} from './checkpoint.js';
// Re-export host-side agent-config staging from sandbox-docker so cloud
// providers (sandbox-daytona, future cloud backends) can use them without
// taking a direct sandbox-docker dep (which would bend the provider-isolation
// rule). The implementations live in sandbox-docker for historical reasons:
// they were originally built for the docker rsync-into-volume flow and stayed
// there when the cloud path adopted them.
export {
  stageClaudeStaticForUpload,
  stageClaudeJsonOnlyForUpload,
  stageClaudeCredentialsForUpload,
  stageCodexStaticForUpload,
  stageCodexCredentialsForUpload,
  stageAgentsStaticForUpload,
  stageOpencodeStaticForUpload,
  stageOpencodeCredentialsForUpload,
  type StageClaudeOptions,
  type StageCodexOptions,
  type StageOpencodeOptions,
  type StageResult,
} from '@agentbox/sandbox-core';
export {
  CREDENTIALS_BACKUP_FILE,
  CODEX_CREDENTIALS_BACKUP_FILE,
  OPENCODE_CREDENTIALS_BACKUP_FILE,
  isRealAgentCredential,
  type CredentialAgentKind,
} from '@agentbox/sandbox-docker';
// Portless helpers — same re-export pattern as the stage* helpers above.
// Lives in sandbox-docker for historical reasons (the file predates the
// hetzner provider), surfaced here so non-docker providers (sandbox-hetzner,
// any future SSH-tunneled backend) don't need a direct sandbox-docker dep.
// Phase 1 of the hetzner provider work: `portlessBrowserEnv` now takes a
// `{ mapTarget }` option so the in-box Chromium remap targets the right host
// gateway per provider (`host.docker.internal` for docker, `127.0.0.1` for
// hetzner where the box is the VPS).
export {
  detectPortless,
  ensurePortlessProxy,
  installPortless,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessInstallHint,
  portlessServiceHint,
  portlessServiceStatus,
  portlessStartHint,
  portlessDoctorRow,
  portlessUnalias,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  startPortlessProxy,
  PORTLESS_PROXY_PORT,
  type PortlessBrowserEnvOptions,
  type PortlessServiceState,
  type PortlessState,
} from '@agentbox/sandbox-docker';

export { seedAgentDeclaredFilesViaTransport } from './sync/agent-seed.js';
