/**
 * The Daytona Cloud sandbox provider. A thin `CloudBackend` over
 * `@daytonaio/sdk`, composed via `@agentbox/sandbox-cloud`'s `createCloudProvider`
 * for everything provider-agnostic (workspace seeding, ctl launch, state).
 */

import type { Provider } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { daytonaBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { prepareDaytona } from './prepare.js';
import { currentDaytonaBaseFingerprintLive } from './prepared-state.js';

const cloudProvider = createCloudProvider(daytonaBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
});

export const daytonaProvider: Provider = {
  ...cloudProvider,
  prepare: prepareDaytona,
  baseFingerprint: () => currentDaytonaBaseFingerprintLive(),
};

export { daytonaBackend, DEFAULT_BOX_IMAGE_REF };
export { resolveDockerfileContext, type DockerfileContext } from './dockerfile-context.js';
export { ensureDaytonaEnvLoaded } from './env-loader.js';
export { currentDaytonaBaseFingerprintLive } from './prepared-state.js';
// Called by the CLI provider registry to gate first-run interactive setup.
// Plain async function — no commander surface — so adding it here doesn't
// pull commander/clack into consumers' type graphs. The full CLI command
// lives at the `./cli` subpath export.
export { ensureDaytonaCredentials } from './credentials.js';
export type { EnsureDaytonaCredentialsOptions } from './credentials.js';
export {
  getDaytonaStatus,
  type DaytonaStatus,
  type DaytonaSnapshotSummary,
  type DaytonaVolumeSummary,
} from './status.js';
