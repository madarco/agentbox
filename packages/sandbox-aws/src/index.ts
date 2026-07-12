/**
 * The AWS EC2 sandbox provider. A thin `CloudBackend` over OpenSSH + the EC2
 * API, composed via `@agentbox/sandbox-cloud`'s `createCloudProvider` for the
 * provider-agnostic scaffolding (workspace seeding, ctl launch, state, relay
 * polling, VNC, checkpoints).
 */

import type { Provider } from '@agentbox/core';
import type { ProviderModule } from '@agentbox/sandbox-core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { awsBackend } from './backend.js';
import { prepareAwsProvider } from './prepare.js';
import { currentAwsBaseFingerprintLive } from './prepared-state.js';
import { ensureAwsCredentials, setAwsCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

const cloudProvider = createCloudProvider(awsBackend, {
  // t3.medium = 2 vCPU / 4 GB; the 40 GB is our own gp3 root volume (EC2's own
  // 8 GB default cannot hold the base image).
  defaultResources: { cpu: 2, memory: 4, disk: 40 },
});

export const awsProvider: Provider = {
  ...cloudProvider,
  prepare: prepareAwsProvider,
  baseFingerprint: (claudeInstall) => currentAwsBaseFingerprintLive(claudeInstall),
};

/** The uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: awsProvider,
  backend: awsBackend,
  ensureCredentials: ensureAwsCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: setAwsCredentials,
  currentBaseFingerprintLive: (claudeInstall) => currentAwsBaseFingerprintLive(claudeInstall),
  doctorChecks,
};

export { awsBackend, AWS_DEFAULT_BOX_IMAGE_REF, mapState, resolveImageRef } from './backend.js';
export { ensureAwsEnvLoaded, AWS_KEYS } from './env-loader.js';
export {
  ensureAwsCredentials,
  setAwsCredentials,
  readAwsCredStatus,
  readAwsProfiles,
  secretsPath,
  maskKey,
  type AwsCredStatus,
  type AwsProfile,
  type EnsureAwsCredentialsOptions,
} from './credentials.js';
export {
  ensureAwsBaseAmi,
  prepareAws,
  prepareAwsProvider,
  type PrepareAwsOptions,
  type PrepareAwsResult,
} from './prepare.js';
export {
  AGENTBOX_EC2_POLICY,
  POLICY_JSON,
  POLICY_NAME,
  preflightPermissions,
  renderPolicyForUser,
  policyFilePath,
  type PermissionReport,
} from './setup-iam.js';
export {
  cloudInitBoxEnv,
  generateBoxCloudInit,
  generatePrepareCloudInit,
  type BoxCloudInitOptions,
  type PrepareCloudInitOptions,
} from './cloud-init.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  findStagedCliRuntimeRoot,
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
export { SshTunnelManager, defaultBoxSshDir } from './ssh-tunnel.js';
export { pollUntil, type PollOptions } from './poll.js';
export {
  currentAwsBaseFingerprintLive,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedAwsState,
  type PreparedBaseAmi,
} from './prepared-state.js';
export {
  allowedSshSources,
  createPerBoxSecurityGroup,
  deletePerBoxSecurityGroup,
  normalizeSourceCidr,
  resolveFirewallSource,
  securityGroupIdFromTags,
  securityGroupNeedsSync,
  syncSecurityGroupSources,
} from './security-group.js';
export { resolveDefaultSubnet, type ResolvedSubnet } from './subnet.js';
export { mapAwsProvisionError, validateInstanceChoice, type InstanceChoice } from './preflight.js';
export { detectEgressIp } from './egress-ip.js';
export { withAwsRetry, isRetriable } from './retry.js';
export {
  AwsApiError,
  makeAwsClient,
  toAwsApiError,
  PROBE_IAM_ACTION,
  type AwsClient,
  type AwsDryRunProbe,
  type AwsImage,
  type AwsInstance,
  type AwsInstanceTypeInfo,
  type AwsSecurityGroup,
  type AwsSubnet,
  type AwsVpc,
} from './client.js';
