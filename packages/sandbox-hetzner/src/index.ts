/**
 * The Hetzner Cloud VPS sandbox provider. A thin `CloudBackend` over OpenSSH
 * + the Hetzner Cloud REST API, composed via `@agentbox/sandbox-cloud`'s
 * `createCloudProvider` for the provider-agnostic scaffolding (workspace
 * seeding, ctl launch, state, relay polling, VNC, checkpoints).
 *
 * **Phase 2 status:** the SDK shim (auth + REST client + retry + firewall
 * + egress IP) is wired; `hetznerBackend` is a stub whose per-method bodies
 * throw `notImplemented` until Phase 4 plumbs in SSH ControlMaster +
 * provisioning. The provider is registered so `--provider hetzner` resolves
 * cleanly and the build is honest about what's missing.
 */

import type { Provider } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { hetznerBackend, HETZNER_DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { prepareHetznerProvider } from './prepare.js';
import { currentHetznerBaseFingerprintLive } from './prepared-state.js';

const cloudProvider = createCloudProvider(hetznerBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 40 },
});

export const hetznerProvider: Provider = {
  ...cloudProvider,
  prepare: prepareHetznerProvider,
  baseFingerprint: () => currentHetznerBaseFingerprintLive(),
};

export { hetznerBackend, HETZNER_DEFAULT_BOX_IMAGE_REF };
export { ensureHetznerEnvLoaded } from './env-loader.js';
export {
  ensureHetznerCredentials,
  readHetznerCredStatus,
  secretsPath,
  maskKey,
  type EnsureHetznerCredentialsOptions,
  type HetznerCredStatus,
} from './credentials.js';
export {
  ensureHetznerBaseSnapshot,
  prepareHetzner,
  prepareHetznerProvider,
  type PrepareHetznerOptions,
  type PrepareHetznerResult,
} from './prepare.js';
export { generateBoxCloudInit, generatePrepareCloudInit, controlPlaneCloudInit, type BoxCloudInitOptions, type PrepareCloudInitOptions, type ControlPlaneCloudInitOptions } from './cloud-init.js';
export {
  deployControlPlaneToHetzner,
  type ControlPlaneHetznerDeployOptions,
  type ControlPlaneHetznerDeployResult,
} from './control-plane-deploy.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  type ResolvedAsset,
  type RuntimeAsset,
} from './runtime-assets.js';
export { mintPrepareKey, mintSshKey, type MintedSshKey } from './ssh-key.js';
export {
  scpDownload,
  scpUpload,
  sshExec,
  sshOptArgs,
  waitForSsh,
  type SshExecOptions,
  type SshExecResult,
  type SshTargetArgs,
} from './ssh-cli.js';
export { pollUntil, type PollOptions } from './poll.js';
export {
  currentHetznerBaseFingerprintLive,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedBaseSnapshot,
  type PreparedHetznerState,
} from './prepared-state.js';
export {
  makeHetznerClient,
  HetznerApiError,
  DEFAULT_HCLOUD_ENDPOINT,
  type CreateFirewallRequest,
  type CreateServerRequest,
  type HetznerAction,
  type HetznerClient,
  type HetznerFirewall,
  type HetznerFirewallRule,
  type HetznerImage,
  type HetznerServer,
  type HetznerServerStatus,
  type HetznerSshKey,
} from './client.js';
export { detectEgressIp, type DetectEgressIpOptions } from './egress-ip.js';
export {
  createPerBoxFirewall,
  deletePerBoxFirewall,
  normalizeSourceCidr,
  sshOnlyInboundRule,
  syncFirewallSource,
  type CreateFirewallOptions,
} from './firewall.js';
export { withHetznerRetry, isAttemptTimeout, isRetriable } from './retry.js';
