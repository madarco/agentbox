export {
  BUILT_IN_DEFAULTS,
  KEY_REGISTRY,
  lookupKey,
  UserConfigError,
  type BrowserKind,
  type ConfigLayer,
  type ConfigScope,
  type ConfigSource,
  type EffectiveConfig,
  type EngineKind,
  type IdeFlavor,
  type KeyDescriptor,
  type KeyType,
  type LoadedConfig,
  type UserConfig,
} from './types.js';

export {
  coerceFromString,
  parseUserConfig,
  parseUserConfigObject,
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
  type LoadEffectiveConfigOptions,
} from './load.js';

export {
  bumpProjectGcCounter,
  listProjectsConfigured,
  pruneOrphanProjectConfigs,
  setConfigValue,
  unsetConfigValue,
  type PruneOrphanProjectConfigsOptions,
  type PruneOrphanProjectConfigsResult,
} from './write.js';
