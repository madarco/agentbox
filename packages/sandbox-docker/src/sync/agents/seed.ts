/**
 * Place an agent's declared `seeds` (`AgentSyncSpec.seeds`) into its docker
 * config volume, from the image-baked copies.
 *
 * Replaces `seedSetupSkillIntoVolume` / `seedCodexHooks` / `seedOpencodePlugin`,
 * which were the same throwaway-container copy written three times. The script
 * itself is built in `@agentbox/sandbox-core` so the cloud path runs the same
 * plan against the live box — that is the whole point, since the cloud path
 * previously ran nothing at all.
 *
 * Reads the volume through a throwaway container rather than a host bind mount:
 * a named volume is the only handle that works while the box is stopped, and
 * `remote-docker` drives a docker engine on another machine where a host path
 * would not resolve.
 */

import { execa } from 'execa';
import {
  agentSeedPlacements,
  buildAgentSeedScript,
  parseSeedMarkers,
  planAgentSeeds,
  resolveAgentSpec,
  type AgentId,
} from '@agentbox/sandbox-core';
import { CONTAINER_USER } from './claude.js';

/** Volume mount point inside the throwaway container. */
const DST = '/dst';

/**
 * Copy every declared seed for `agent` into `volume`. Best-effort: returns the
 * `destRel`s that actually landed and never throws — a box create must not fail
 * because an activity hook could not be copied.
 */
export async function seedAgentDeclaredFiles(
  agent: AgentId,
  volume: string,
  image: string,
): Promise<{ seeded: string[] }> {
  const spec = resolveAgentSpec(agent);
  if (!spec.seeds || spec.seeds.length === 0) return { seeded: [] };
  // Root, so it can write into a freshly created volume; chown by NAME because
  // the box user's uid is not 1000 on every provider.
  const script = buildAgentSeedScript(planAgentSeeds(spec.seeds, DST), {
    owner: `${CONTAINER_USER}:${CONTAINER_USER}`,
  });
  try {
    const { stdout } = await execa('docker', [
      'run',
      '--rm',
      '--user',
      '0',
      '-v',
      `${volume}:${DST}`,
      image,
      'sh',
      '-c',
      script,
    ]);
    return { seeded: parseSeedMarkers(stdout) };
  } catch {
    return { seeded: [] };
  }
}

/** Human-readable labels for what a seed run copied, for the create/start log. */
export function seedLabels(agent: AgentId, seeded: readonly string[]): string[] {
  const byRel = new Map(agentSeedPlacements(agent).map((p) => [p.destRel, p.label]));
  return seeded.map((rel) => byRel.get(rel) ?? rel);
}
