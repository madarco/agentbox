/**
 * The DigitalOcean Droplet sandbox provider. A thin `CloudBackend` over
 * OpenSSH + the DigitalOcean API v2, composed via `@agentbox/sandbox-cloud`'s
 * `createCloudProvider` for the provider-agnostic scaffolding (workspace
 * seeding, ctl launch, state, relay polling, VNC, checkpoints).
 */

import type { Provider } from '@agentbox/core';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { digitaloceanBackend, DIGITALOCEAN_DEFAULT_BOX_IMAGE_REF } from './backend.js';
import { prepareDigitalOceanProvider } from './prepare.js';
import {
  currentDigitalOceanBaseFingerprintLive,
  currentDigitalOceanBaseFileHashes,
} from './prepared-state.js';
import { ensureDigitalOceanCredentials, setDigitalOceanCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

const cloudProvider = createCloudProvider(digitaloceanBackend, {
  // s-2vcpu-4gb = 2 vCPU / 4 GB / 80 GB SSD.
  defaultResources: { cpu: 2, memory: 4, disk: 80 },
});

export const digitaloceanProvider: Provider = {
  ...cloudProvider,
  prepare: prepareDigitalOceanProvider,
  baseFingerprint: (agentInstall) => currentDigitalOceanBaseFingerprintLive(agentInstall),
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: digitaloceanProvider,
  backend: digitaloceanBackend,
  ensureCredentials: ensureDigitalOceanCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: setDigitalOceanCredentials,
  currentBaseFingerprintLive: (agentInstall) =>
    currentDigitalOceanBaseFingerprintLive(agentInstall),
  currentBaseFileHashes: () => currentDigitalOceanBaseFileHashes(),
  doctorChecks,
};

export { digitaloceanBackend, DIGITALOCEAN_DEFAULT_BOX_IMAGE_REF };
export { ensureDigitalOceanEnvLoaded } from './env-loader.js';
export {
  ensureDigitalOceanCredentials,
  setDigitalOceanCredentials,
  readDigitalOceanCredStatus,
  secretsPath,
  maskKey,
  type EnsureDigitalOceanCredentialsOptions,
  type DigitalOceanCredStatus,
} from './credentials.js';
export {
  ensureDigitalOceanBaseSnapshot,
  prepareDigitalOcean,
  prepareDigitalOceanProvider,
  type PrepareDigitalOceanOptions,
  type PrepareDigitalOceanResult,
} from './prepare.js';
export {
  generateBoxCloudInit,
  generateDerivedPrepareCloudInit,
  generatePrepareCloudInit,
  controlPlaneCloudInit,
  type BoxCloudInitOptions,
  type PrepareCloudInitOptions,
  type ControlPlaneCloudInitOptions,
} from './cloud-init.js';
export {
  deployControlPlaneToDigitalOcean,
  updateControlPlaneOnDigitalOcean,
  destroyControlPlaneOnDigitalOcean,
  type ControlPlaneDigitalOceanDeployOptions,
  type ControlPlaneDigitalOceanDeployResult,
  type ControlPlaneDigitalOceanUpdateOptions,
  type ControlPlaneDestroyResult,
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
  currentDigitalOceanBaseFingerprintLive,
  preparedEntryFor,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedBaseSnapshot,
  type PreparedDigitalOceanState,
} from './prepared-state.js';
export {
  makeDigitalOceanClient,
  DigitalOceanApiError,
  DEFAULT_DO_ENDPOINT,
  type CreateDropletRequest,
  type CreateFirewallRequest,
  type DigitalOceanAccount,
  type DigitalOceanAction,
  type DigitalOceanClient,
  type DigitalOceanDroplet,
  type DigitalOceanDropletStatus,
  type DigitalOceanFirewall,
  type DigitalOceanInboundRule,
  type DigitalOceanOutboundRule,
  type DigitalOceanProject,
  type DigitalOceanSize,
  type DigitalOceanSnapshot,
} from './client.js';
export {
  validateSizeChoice,
  resolveProjectChoice,
  mapDigitalOceanProvisionError,
  type SizeChoice,
} from './preflight.js';
export { detectEgressIp, type DetectEgressIpOptions } from './egress-ip.js';
export {
  allowAllOutboundRules,
  controlPlaneInboundRules,
  createPerBoxFirewall,
  deletePerBoxFirewall,
  findFirewallForDroplet,
  firewallNeedsSync,
  normalizeSourceCidr,
  sshInboundRules,
  syncFirewallSource,
  type CreateFirewallOptions,
} from './firewall.js';
export { withDigitalOceanRetry, isAttemptTimeout, isRetriable } from './retry.js';
