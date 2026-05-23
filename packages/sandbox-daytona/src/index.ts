/**
 * The Daytona Cloud sandbox provider. A thin `CloudBackend` over
 * `@daytonaio/sdk`, composed via `@agentbox/sandbox-cloud`'s `createCloudProvider`
 * for everything provider-agnostic (workspace seeding, ctl launch, state).
 */

import type { Provider } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { daytonaBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';

export const daytonaProvider: Provider = createCloudProvider(daytonaBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
});

export { daytonaBackend, DEFAULT_BOX_IMAGE_REF };
export { resolveDockerfileContext, type DockerfileContext } from './dockerfile-context.js';
