/**
 * The Daytona Cloud sandbox provider. A thin `CloudBackend` over
 * `@daytona/sdk`, composed via `@agentbox/sandbox-cloud`'s `createCloudProvider`
 * for everything provider-agnostic (workspace seeding, ctl launch, state).
 */

import type { Provider } from '@agentbox/core';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { DAYTONA_DEFAULT_RESOURCES, daytonaBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { makeDaytonaCheckpoint } from './checkpoint.js';
import { prepareDaytona } from './prepare.js';
import { currentDaytonaBaseFingerprintLive } from './prepared-state.js';
import { ensureDaytonaCredentials, setDaytonaCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

const cloudProvider = createCloudProvider(daytonaBackend, {
  defaultResources: { ...DAYTONA_DEFAULT_RESOURCES },
});

export const daytonaProvider: Provider = {
  ...cloudProvider,
  prepare: prepareDaytona,
  // Overrides the generic cloud checkpoint: a Daytona cold snapshot needs the
  // sandbox stopped, which kills the in-box daemons, so the capture has to
  // reconnect the box afterwards. See `makeDaytonaCheckpoint`.
  checkpoint: makeDaytonaCheckpoint(cloudProvider),
  baseFingerprint: (claudeInstall) => currentDaytonaBaseFingerprintLive(claudeInstall),
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: daytonaProvider,
  backend: daytonaBackend,
  ensureCredentials: ensureDaytonaCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: setDaytonaCredentials,
  currentBaseFingerprintLive: (claudeInstall) => currentDaytonaBaseFingerprintLive(claudeInstall),
  doctorChecks,
};

export { DAYTONA_DEFAULT_RESOURCES, daytonaBackend, DEFAULT_BOX_IMAGE_REF };
export { resolveDockerfileContext, type DockerfileContext } from './dockerfile-context.js';
export { ensureDaytonaEnvLoaded } from './env-loader.js';
export { currentDaytonaBaseFingerprintLive } from './prepared-state.js';
// Called by the CLI provider registry to gate first-run interactive setup.
// Plain async function — no commander surface — so adding it here doesn't
// pull commander/clack into consumers' type graphs. The full CLI command
// lives at the `./cli` subpath export.
export { ensureDaytonaCredentials, setDaytonaCredentials } from './credentials.js';
export type { EnsureDaytonaCredentialsOptions } from './credentials.js';
export {
  getDaytonaStatus,
  type DaytonaStatus,
  type DaytonaSnapshotSummary,
  type DaytonaVolumeSummary,
} from './status.js';
