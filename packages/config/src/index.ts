export {
  BUILT_IN_DEFAULTS,
  KEY_REGISTRY,
  lookupKey,
  UserConfigError,
  type AttachOpenIn,
  type BrowserKind,
  type ConfigLayer,
  type ConfigScope,
  type ConfigSource,
  type EffectiveConfig,
  type EngineKind,
  type GitPushMode,
  type IdeFlavor,
  type KeyDescriptor,
  type KeyType,
  type LoadedConfig,
  type ProviderKind,
  type QueueOpenIn,
  type UserConfig,
} from './types.js';

export {
  PROVIDERS,
  PROVIDER_NAMES,
  CLOUD_PROVIDER_NAMES,
  isProviderKind,
  providerMeta,
  providerKeyCap,
  perProviderConfigKey,
  type ProviderMeta,
} from './providers.js';

export {
  coerceFromString,
  parseUserConfig,
  parseUserConfigObject,
  type ParseOptions,
} from './parse.js';

export {
  configPathFor,
  findProjectRoot,
  GLOBAL_CONFIG_FILE,
  hashProjectPath,
  projectConfigDir,
  projectConfigFile,
  projectDirSegment,
  projectMetaFile,
  PROJECTS_DIR,
  sanitizeMnemonic,
  STATE_DIR,
  workspaceConfigFile,
  WORKSPACE_CONFIG_BASENAME,
  type ProjectRoot,
} from './paths.js';

export {
  loadEffectiveConfig,
  loadProjectAgentboxDefaults,
  setConfigWarningSink,
  type LoadEffectiveConfigOptions,
} from './load.js';

export {
  defaultCheckpointConfigKey,
  resolveDefaultCheckpoint,
} from './checkpoint.js';

export { resolveBoxSize } from './size.js';

export {
  DAYTONA_VM_REGION,
  resolveDaytonaClass,
  resolveDaytonaRegion,
  type DaytonaSandboxClass,
} from './daytona.js';

export {
  boxImageConfigKey,
  resolveBoxImage,
} from './image.js';

export {
  bumpProjectGcCounter,
  listProjectsConfigured,
  pruneOrphanProjectConfigs,
  registerProject,
  setConfigValue,
  unregisterProject,
  unsetConfigValue,
  type ProjectEntry,
  type PruneOrphanProjectConfigsOptions,
  type PruneOrphanProjectConfigsResult,
} from './write.js';
