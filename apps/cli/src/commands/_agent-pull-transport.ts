/**
 * One `SyncTransport` for `agentbox download <agent>`, whatever the provider.
 *
 * The three download commands each used to branch on `box.provider`: cloud went
 * through the shared `pull<Agent>ViaTransport`, docker called a hand-rolled
 * `pull<Agent>Config` that ran its own `docker run -v <volume>` containers. The
 * docker copies had drifted — two of them invented their own inventory shell
 * dialect instead of `flatInventoryScript`, and codex's `cp -a` dropped the
 * `chmod 0600` the shared path applies to `auth.json`.
 *
 * `createDockerVolumeSyncTransport` removes the reason for the branch: it mounts
 * the config volume AT ITS BOX PATH, so the shared implementation reads the same
 * box-absolute paths and the box still does not have to be running — the
 * property the docker path existed for in the first place.
 */

import { log } from '@clack/prompts';
import type { AgentId, BoxRecord, SyncTransport } from '@agentbox/core';
import { agentConfigVolume } from '@agentbox/core';
import { agentBoxDir, resolveAgentSpec } from '@agentbox/sandbox-core';
import { createDockerVolumeSyncTransport, DEFAULT_BOX_IMAGE } from '@agentbox/sandbox-docker';
import { cloudTransportForPull } from './_agent-pull.js';

export interface AgentPullTransport {
  transport: SyncTransport;
  /** The docker volume being read, when this is a docker box. For messages. */
  volume?: string;
}

export async function pullTransportForBox(
  box: BoxRecord,
  agent: AgentId,
): Promise<AgentPullTransport> {
  if ((box.provider ?? 'docker') !== 'docker') {
    return { transport: await cloudTransportForPull(box) };
  }
  const spec = resolveAgentSpec(agent);
  const volume =
    agentConfigVolume(box, agent) ??
    // No per-box volume recorded: the box mounts the agent's shared one.
    spec.dockerVolume;
  if (volume === spec.dockerVolume) {
    log.warn(
      `Reading the shared ${volume} volume — it aggregates ${spec.id} config from ANY box, not just ${box.name}.`,
    );
  }
  return {
    transport: createDockerVolumeSyncTransport({
      volume,
      // The volume's box path, from the registry — never a literal, or the
      // shared implementation's box-absolute paths stop resolving.
      mountPath: agentBoxDir(agent),
      image: box.image || DEFAULT_BOX_IMAGE,
    }),
    volume,
  };
}
