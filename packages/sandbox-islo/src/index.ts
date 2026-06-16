import type { Provider } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { DEFAULT_BOX_IMAGE_REF, DEFAULT_ISLO_IMAGE_REF, isloBackend } from './backend.js';

const cloudProvider = createCloudProvider(isloBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 10 },
  launchDockerd: false,
});

export const isloProvider: Provider = {
  ...cloudProvider,
};

export { DEFAULT_BOX_IMAGE_REF, DEFAULT_ISLO_IMAGE_REF, isloBackend };
export { ensureIsloEnvLoaded, reloadIsloEnv } from './env-loader.js';
export {
  ensureIsloCredentials,
  maskKey,
  readIsloCredStatus,
  secretsPath,
  type EnsureIsloCredentialsOptions,
  type IsloCredStatus,
} from './credentials.js';
