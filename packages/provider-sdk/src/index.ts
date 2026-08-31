/**
 * `@madarco/agentbox-provider-sdk` — the public, semver'd surface for building an
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
export const SDK_API_VERSION = 3;

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

// ---- conformance: a reference in-memory backend to certify your CloudBackend ----
export {
  makeMockCloudBackend,
  type MockCloudBackend,
  type MockCloudBackendOptions,
} from '@agentbox/sandbox-cloud';

// ---- provider module contract + doctor helpers ----
export {
  errSummary,
  firstLine,
  type ProviderModule,
  type CheckResult,
  type CheckStatus,
  type CredStatusSummary,
} from '@agentbox/sandbox-core';

// ---- declarative provider metadata ----
// Declare a `descriptor` on your `providerModule` and AgentBox's UIs can render
// your provider properly: a real label, the right credential fields, and correct
// checkpoint / SSH / pause / VNC gating. `agentbox plugin add` snapshots it into
// `~/.agentbox/plugins.json`, so every consumer reads it without importing you.
//
// OPTIONAL: omit it and you get a descriptor derived from your module plus
// defaults that reproduce pre-descriptor behavior — nothing breaks, you just
// show up as your bare provider name.
export {
  type ProviderDescriptor,
  type ProviderCapabilities,
  type ProviderCredentialField,
} from '@agentbox/config';
export {
  resolveProviderDescriptor,
  listProviderDescriptors,
  deriveDescriptor,
} from '@agentbox/sandbox-core';

// ---- box-state + host helpers a backend/CLI surface may touch ----
export {
  recordBox,
  readState,
  removeBoxRecord,
  allocateProjectIndex,
  resolveBoxRef,
  hostOpenCommand,
} from '@agentbox/sandbox-core';

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

// ---- per-agent variants (the "one agent per box" tier) ----
// A box is created FOR an agent set, and a provider may bake one artifact per
// set on top of its agentless base — `prepare --agents claude` — so an
// `agentbox claude` box boots with the agent already in place instead of
// installing it at create.
//
// OPTIONAL: `agents` is optional on both `PrepareOptions` and
// `CloudProvisionRequest`, so a provider that ignores it keeps working — it
// always boots its base and `ensureAgentInstalled` adds the agent at create.
// That is the intended graceful degradation, which is why supporting variants
// needs no `SDK_API_VERSION` bump.
//
// To OPT IN you need all of these:
//   - `normalizeAgentSet` + `agentSetArg` to build the variant key (`''` is the
//     agentless base). Order-insensitive, so ['codex','claude'] and
//     ['claude','codex'] resolve to the same artifact.
//   - `variantFingerprint` instead of `claudeInstallFingerprint` — it folds the
//     agent set into the hash, and is the IDENTITY for the empty set, so
//     existing base records stay valid.
//   - `resolveAgentSpec` + `resolveAgentInstall` + `renderInstallRecipe` +
//     `renderPackageInstall` to render an agent's install into your bake. These
//     are the same data the built-in providers and the runtime installer use,
//     so a baked agent and a runtime-added one end up identical.
//
// `renderPackageInstall` dispatches on the package manager the box actually has
// (apt-get | dnf | microdnf) rather than assuming Debian — Vercel's sandboxes
// are Amazon Linux, where `apt-get` exits 127.
export {
  variantFingerprint,
  normalizeAgentSet,
  agentSetArg,
  resolveAgentSpec,
  resolveAgentInstall,
  renderInstallRecipe,
  renderPackageInstall,
} from '@agentbox/sandbox-core';

// ---- config access ----
export { loadEffectiveConfig, findProjectRoot, type EffectiveConfig } from '@agentbox/config';

// ---- interactive attach helpers (build a cloud box's `buildAttach` argv) ----
// A provider with no SSH (like vercel/e2b) overrides `buildAttach` and drives
// its own PTY transport; these render the shared inner tmux command + forward a
// safe TERM, exactly as the built-in cloud providers do.
export { hostTermForCloud, renderInnerCommand } from '@agentbox/sandbox-cloud';

// ---- prepare-time agent-config staging (bake host ~/.claude etc into a base) ----
// A provider that bakes its base image by booting a builder sandbox stages the
// host's static agent config into the snapshot with this — the same call every
// built-in cloud `prepare` flow uses.
//
// v3 REPLACED the three per-agent stagers (`stageClaudeStaticForUpload` and
// friends) with this one registry-driven call. Naming the agents meant a
// provider staged exactly three of them forever: an agent added later — or
// installed from a package — was silently absent from that provider's baked
// snapshot, with nothing failing. `stageAllAgentStatic` returns one entry per
// agent the host actually knows about, plus the shared `~/.agents` skills tree,
// each with the `extractDir` to unpack it at.
export { stageAllAgentStatic, type AgentStaticStage } from '@agentbox/sandbox-core';
export { stageAgentsStaticForUpload, type StageResult } from '@agentbox/sandbox-cloud';

// ---- cloud checkpoint authoring (for id-addressed-snapshot providers) ----
// A provider whose snapshots are id-addressed (like vercel/e2b, where the cloud
// returns an opaque snapshot id you can't name) overrides the whole `checkpoint`
// capability instead of using the scaffold default. These are the host-side
// manifest helpers that override needs — the same ones the built-in vercel/e2b
// providers use.
export {
  writeCloudCheckpointManifest,
  listCloudCheckpoints,
  resolveCloudCheckpoint,
  removeCloudCheckpointDir,
  currentCloudBaseFingerprint,
  type CloudCheckpointInfo,
  type CloudCheckpointManifest,
  type WriteCloudManifestFields,
} from '@agentbox/sandbox-cloud';

// ---- shared box-side runtime assets (ctl.cjs + shims from the running CLI) ----
export {
  resolveSharedRuntimeAsset,
  sharedRuntimeDir,
  CLI_RUNTIME_DIR_ENV,
  SHARED_RUNTIME_ASSETS,
  type SharedRuntimeAsset,
} from './runtime-assets.js';
