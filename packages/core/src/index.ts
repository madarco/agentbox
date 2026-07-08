export type {
  AgentKind,
  BoxDescriptor,
  BoxId,
  BoxResourceLimits,
  BoxResourceStats,
  BoxState,
  SandboxProvider,
  StartBoxOptions,
} from './types.js';
export type { AgentLauncher } from './agent.js';
export { resolveAgentLauncher } from './agent.js';
export type {
  BoxRecord,
  CloudBoxFields,
  DockerBoxFields,
  FindBoxResult,
  GitWorktreeRecord,
  ProviderName,
  SshTargetRecord,
  StateFile,
} from './box-record.js';
export { dockerField } from './box-record.js';
export type { BoxEndpoint, BoxEndpoints } from './endpoints.js';
export type {
  AttachKind,
  AttachSpec,
  BoxRuntimeState,
  BuildAttachOptions,
  CreateBoxLimits,
  CreateBoxRequest,
  CreatedBox,
  ExecOptions,
  ExecResult,
  InspectedBox,
  PrepareOptions,
  PrepareResult,
  Provider,
  ProviderCheckpoint,
  ResolvedCarryEntry,
  ResyncResult,
} from './provider.js';
export {
  applyReplacements,
  substitutePlaceholders,
  placeholderContextFromEnv,
  deriveBoxHost,
  parseReplaceRule,
  parseReplaceRules,
  parseReplacements,
  resolveRuleRefs,
  parseRuleArg,
  PLACEHOLDER_KEYS,
  ReplaceError,
} from './replace.js';
export type {
  ReplaceRule,
  ApplyReplacementsOptions,
  PlaceholderKey,
} from './replace.js';
export type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
  CloudVolumeMount,
} from './cloud-backend.js';
export { AmbiguousBoxError, BoxNotFoundError, UserFacingError } from './errors.js';
export { BOX_ID_PREFIX, generateBoxId } from './identity.js';
export * from './sync/index.js';
