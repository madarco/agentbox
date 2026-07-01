export {
  CLOUD_WEB_PROXY_PORT,
  CLOUD_WORKSPACE_DIR,
  createCloudProvider,
  emptyCloudStats,
  hostTermForCloud,
  renderInnerCommand,
  type CreateCloudProviderOptions,
} from './cloud-provider.js';
export { kickCloudBootstrap, type KickCloudBootstrapArgs } from './bootstrap-launch.js';
export {
  seedCloudWorkspace,
  type SeedCloudWorkspaceArgs,
  type SeedCloudWorkspaceResult,
} from './workspace-seed.js';
export {
  agentSpecsForCloud,
  ensureAgentHomeDirsOwned,
  ensureAgentVolumesForCloud,
  extractCloudAgentCredentials,
  seedAgentVolumesIfFresh,
  seedOpencodeModelState,
  type CloudAgentKind,
  type EnsureAgentVolumesResult,
  type SeedAgentVolumesOptions,
} from './agent-credentials.js';
export { uploadEnvFiles, type UploadEnvFilesArgs, type UploadEnvFilesResult } from './env-files.js';
export { seedDynamicConfig, type SeedDynamicConfigOptions } from './dynamic-sync.js';
export {
  seedClaudeJsonAtCreate,
  type SeedClaudeJsonOptions,
} from './claude-json-overlay.js';
export { seedGitIdentity, type SeedGitIdentityOptions } from './git-identity.js';
export { bashScript, quoteShellArg, quoteShellArgv } from './shell.js';
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
  cloudSnapshotName,
  currentCloudBaseFingerprint,
  listAllCloudCheckpoints,
  listCloudCheckpoints,
  probeCloudCheckpoint,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  writeCloudCheckpointManifest,
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
  CREDENTIALS_BACKUP_FILE,
  CODEX_CREDENTIALS_BACKUP_FILE,
  OPENCODE_CREDENTIALS_BACKUP_FILE,
  isRealAgentCredential,
  type CredentialAgentKind,
  type StageClaudeOptions,
  type StageCodexOptions,
  type StageOpencodeOptions,
  type StageResult,
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
  installPortless,
  portlessAlias,
  portlessBrowserEnv,
  portlessGetUrl,
  portlessInstallHint,
  portlessStartHint,
  portlessUnalias,
  resetPortlessCache,
  resolvePortlessHostStateDir,
  startPortlessProxy,
  PORTLESS_PROXY_PORT,
  type PortlessBrowserEnvOptions,
  type PortlessState,
} from '@agentbox/sandbox-docker';
