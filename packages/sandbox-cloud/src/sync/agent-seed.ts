/**
 * Place an agent's declared `seeds` (`AgentSyncSpec.seeds`) into a LIVE cloud
 * box — the cloud half of what `@agentbox/sandbox-docker` does against the
 * config volume.
 *
 * This half did not exist. The three seeders were docker-only, so on every cloud
 * provider `~/.codex/hooks.json` was never written and OpenCode's state plugin —
 * its ONLY activity source (`caps.activitySource: 'plugin'`) — never reached the
 * box at all, leaving every cloud OpenCode box reporting `unknown` forever. Same
 * shape of drift as `boxRunEnv` had before it was wired to one declaration.
 *
 * Two sources, in order:
 *   1. the copy baked at `bakedPath` in the provider's base image — free, no
 *      transfer;
 *   2. failing that, an upload of the host's staged `runtime/_shared/` copy.
 * (2) is what makes this fix land on EXISTING snapshots: a base baked before the
 * asset existed has nothing at `bakedPath`, and the VPS providers never shipped
 * the OpenCode plugin in the first place. Without the fallback this would need a
 * re-`prepare` of every provider before it did anything.
 *
 * Best-effort throughout: an agent that cannot get its activity hook is
 * degraded, not broken, and must never fail a box create.
 */

import type { SyncTransport } from '@agentbox/core';
import {
  buildAgentSeedScript,
  parseSeedMarkers,
  planAgentSeeds,
  resolveAgentSpec,
  sharedRuntimeAssetPath,
  type AgentId,
  type AgentSeedSpec,
} from '@agentbox/sandbox-core';

/** Box-side staging path for an uploaded fallback asset. */
function stagingPath(seed: AgentSeedSpec): string {
  return `/tmp/agentbox-seed-${seed.sharedAsset}`;
}

export interface SeedAgentFilesResult {
  /** `destRel`s that landed, whatever the source. */
  seeded: string[];
  /** `destRel`s that had to be uploaded because the base image lacked them. */
  uploaded: string[];
}

/**
 * Seed `agent`'s declared files into the box behind `t`. Runs as the box user
 * (every cloud `exec` does), so no chown is emitted.
 */
export async function seedAgentDeclaredFilesViaTransport(
  t: SyncTransport,
  agent: AgentId,
  opts: { onLog?: (line: string) => void } = {},
): Promise<SeedAgentFilesResult> {
  const log = opts.onLog ?? ((): void => {});
  const spec = resolveAgentSpec(agent);
  const boxDir = spec.staticPaths[0]?.boxDir;
  const seeds = spec.seeds ?? [];
  if (!boxDir || seeds.length === 0) return { seeded: [], uploaded: [] };

  const seeded = new Set<string>();
  try {
    const r = await t.exec(['sh', '-c', buildAgentSeedScript(planAgentSeeds(seeds, boxDir))]);
    for (const rel of parseSeedMarkers(r.stdout)) seeded.add(rel);
  } catch {
    // Fall through to the upload path — an exec failure here is not fatal.
  }

  const uploaded: string[] = [];
  for (const seed of seeds) {
    if (seeded.has(seed.destRel)) continue;
    const hostPath = sharedRuntimeAssetPath(seed.sharedAsset);
    if (!hostPath) {
      log(`could not seed ${seed.label}: absent from the box image and from this CLI's runtime`);
      continue;
    }
    const staged = stagingPath(seed);
    try {
      await t.pushFile(hostPath, staged);
      const script = buildAgentSeedScript(planAgentSeeds([seed], boxDir, { srcFor: () => staged }));
      const r = await t.exec(['sh', '-c', `${script}; rm -f '${staged}'`]);
      if (parseSeedMarkers(r.stdout).includes(seed.destRel)) {
        seeded.add(seed.destRel);
        uploaded.push(seed.destRel);
      }
    } catch {
      log(`could not seed ${seed.label} from the host`);
    }
  }

  for (const seed of seeds) {
    if (!seeded.has(seed.destRel)) continue;
    log(`seeded ${seed.label}${uploaded.includes(seed.destRel) ? ' (from host)' : ''}`);
  }
  return { seeded: [...seeded], uploaded };
}
