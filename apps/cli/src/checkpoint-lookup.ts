/**
 * Provider-aware checkpoint existence check used by the wizard. The default
 * checkpoint name lives in a single config field (`box.defaultCheckpoint`),
 * but the actual artifact may exist for Docker, for Daytona, both, or
 * neither. The wizard consults this helper before announcing "starting from
 * checkpoint …" — if the named checkpoint doesn't exist for the active
 * provider, the wizard falls through to the normal setup flow instead of
 * misleadingly skipping it.
 */

import type { ProviderName } from '@agentbox/core';
import { resolveCheckpoint } from '@agentbox/sandbox-docker';
import { resolveCloudCheckpoint } from '@agentbox/sandbox-cloud';

export async function checkpointExistsForProvider(
  provider: ProviderName,
  projectRoot: string,
  ref: string,
): Promise<boolean> {
  if (provider === 'docker') {
    return (await resolveCheckpoint(projectRoot, ref)) !== null;
  }
  // v1: every cloud backend ships its checkpoints under the
  // `~/.agentbox/cloud-checkpoints/<backend>/…` tree. The provider name is
  // also the backend name so the lookup is a 1:1 mapping.
  return (await resolveCloudCheckpoint(projectRoot, provider, ref)) !== null;
}
