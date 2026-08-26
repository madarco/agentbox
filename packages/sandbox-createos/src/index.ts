/**
 * The CreateOS sandbox provider. It uses the shared cloud scaffold for
 * provider-agnostic workspace seeding, ctl launch, state tracking, relay
 * polling, and public preview URLs.
 *
 * One capability is overridden on top of the cloud scaffold:
 *   - `buildAttach` - CreateOS CLI managed PTY attach (CreateOS has no
 *     AgentBox-managed SSH transport).
 *
 * CreateOS currently differs from E2B/Daytona prepare: AgentBox cannot bake a
 * reusable base image with local runtime files yet, so prepare validates
 * credentials/runtime assets and provision installs the runtime into each
 * fresh rootfs.
 */

import type { Provider } from '@agentbox/core';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import {
  createosBackend,
  CREATEOS_DEFAULT_BOX_IMAGE_REF,
  CREATEOS_DEFAULT_RESOURCES,
} from './backend.js';
import { ensureCreateOsCredentials, setCreateOsCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';
import { prepareCreateos } from './prepare.js';
import { buildCreateosAttach } from './build-attach.js';

const cloudProvider = createCloudProvider(createosBackend, {
  defaultResources: { ...CREATEOS_DEFAULT_RESOURCES },
  launchDockerd: true,
});

export const createosProvider: Provider = {
  ...cloudProvider,
  prepare: prepareCreateos,
  buildAttach: buildCreateosAttach,
};

export const providerModule: ProviderModule = {
  provider: createosProvider,
  backend: createosBackend,
  ensureCredentials: ensureCreateOsCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: (fields) => Promise.resolve(setCreateOsCredentials(fields)),
  doctorChecks,
};

export { createosBackend, CREATEOS_DEFAULT_BOX_IMAGE_REF, CREATEOS_DEFAULT_RESOURCES };
export { ensureCreateOsEnvLoaded, reloadCreateOsEnv } from './env-loader.js';
export {
  ensureCreateOsCredentials,
  setCreateOsCredentials,
  readCreateOsCredStatus,
  secretsPath,
  maskKey,
  type CreateOsCredStatus,
  type EnsureCreateOsCredentialsOptions,
} from './credentials.js';
export {
  CreateOsClient,
  CreateOsApiError,
  DEFAULT_CREATEOS_ENDPOINT,
  makeCreateOsClient,
  type CreateOsCreateSandboxRequest,
  type CreateOsCreateSandboxResponse,
  type CreateOsExecResponse,
  type CreateOsSandboxView,
} from './client.js';
export {
  findStagedCliRuntimeRoot,
  resolveRuntimeAssets,
  RUNTIME_ASSETS,
  candidatesFor,
  type ResolvedAsset,
  type RuntimeAsset,
} from './runtime-assets.js';
export {
  prepareCreateos,
  type PrepareCreateosOptions,
} from './prepare.js';
export { buildCreateosAttach, buildCreateosAttachArgv } from './build-attach.js';
export { detectCreateosCli, resetCreateosCliCache, type CreateosCliState } from './createos-cli.js';
export {
  withCreateOsRetry,
  isAttemptTimeout,
  isRetriable,
  type WithRetryOptions,
} from './retry.js';
