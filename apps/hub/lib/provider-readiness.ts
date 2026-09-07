import type { ProviderKind } from '@agentbox/config';

interface ProviderReadinessInput {
  hasCredentials: boolean;
  hasPreparedBase: boolean;
  remoteDockerHostCount: number;
}

export function providerIsConfigured(id: ProviderKind, input: ProviderReadinessInput): boolean {
  if (id === 'docker') return true;
  if (id === 'remote-docker') return input.remoteDockerHostCount > 0;
  // CreateOS provisions from its selected rootfs and installs the AgentBox
  // runtime per sandbox, so it intentionally has no prepared-base marker.
  if (id === 'createos') return input.hasCredentials;
  return input.hasPreparedBase;
}

export function providerHasReusableBase(id: ProviderKind): boolean {
  return id !== 'createos' && id !== 'remote-docker';
}
