/**
 * `@agentbox/provider-sdk` — the public, semver'd surface for building an
 * AgentBox sandbox provider as an installable community package.
 *
 * A provider package implements the thin `CloudBackend` (~13 methods over a
 * cloud's SDK), wraps it with `createCloudProvider` to get the full lifecycle
 * for free, and exports a `providerModule` (the uniform surface AgentBox loads
 * it through). Publish it as `agentbox-provider-<name>`; users install it and
 * register it with `agentbox plugin add`.
 *
 * This module RE-EXPORTS the provider-facing pieces of AgentBox's internal
 * packages, which are inlined at build time (see tsup `noExternal`). It is the
 * ONLY `@agentbox/*` dependency a plugin needs, and the stable seam that lets
 * AgentBox refactor its internals without breaking published plugins.
 */

/**
 * Major version of the provider contract. A plugin is loaded only if the CLI's
 * supported range includes this major (see `agentbox plugin add`). Bump on any
 * breaking change to `Provider` / `CloudBackend` / `ProviderModule`.
 */
export const SDK_API_VERSION = 1;

// ---- core provider contract (types) ----
export type {
  Provider,
  ProviderName,
  ProviderCheckpoint,
  CreateBoxRequest,
  CreateBoxLimits,
  CreatedBox,
  InspectedBox,
  ExecOptions,
  ExecResult,
  AttachKind,
  AttachSpec,
  BuildAttachOptions,
  BoxRuntimeState,
  PrepareOptions,
  PrepareResult,
  ResyncResult,
  ResolvedCarryEntry,
} from '@agentbox/core';
export type { BoxRecord, CloudBoxFields } from '@agentbox/core';
export type {
  CloudBackend,
  CloudProvisionRequest,
  CloudHandle,
  CloudState,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudPreviewUrl,
  CloudSandboxSummary,
  CloudVolumeMount,
} from '@agentbox/core';
export { UserFacingError, BoxNotFoundError } from '@agentbox/core';

// ---- cloud scaffolding (runtime): "a cloud is one file" ----
export { createCloudProvider, type CreateCloudProviderOptions } from '@agentbox/sandbox-cloud';

// ---- provider module contract + doctor helpers ----
export {
  errSummary,
  firstLine,
  type ProviderModule,
  type CheckResult,
  type CheckStatus,
  type CredStatusSummary,
} from '@agentbox/sandbox-core';

// ---- box-state helpers a backend may touch ----
export { recordBox, readState, removeBoxRecord, allocateProjectIndex } from '@agentbox/sandbox-core';

// ---- prepared-state / base-image fingerprint primitives ----
export {
  computeContextSha256,
  resolveContextFilesFrom,
  readCliStamp,
  shortFingerprint,
  claudeInstallFingerprint,
  readPreparedStateRaw,
  writePreparedStateRaw,
  preparedStatePathFor,
  sha256OfFile,
  type PreparedBaseSnapshot,
  type ContextFile,
  type CliStamp,
} from '@agentbox/sandbox-core';

// ---- config access ----
export { loadEffectiveConfig, type EffectiveConfig } from '@agentbox/config';
