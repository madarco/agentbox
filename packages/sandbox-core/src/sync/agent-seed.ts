/**
 * Placement of the agentbox-OWNED files an agent needs in its config root —
 * `AgentSyncSpec.seeds`, turned into one shell snippet both transports run.
 *
 * There used to be three of these, hand-written, in `@agentbox/sandbox-docker`
 * (`seedSetupSkillIntoVolume`, `seedCodexHooks`, `seedOpencodePlugin`). They
 * differed only in which file went where, and living in the docker package meant
 * the cloud providers did not do it at all: a cloud OpenCode box never received
 * the state plugin that is its ONLY activity source, so it reported `unknown`
 * forever. Same class of drift as `boxRunEnv` before it was wired.
 *
 * The two transports differ in exactly two ways, both parameters here:
 *   - docker copies into a MOUNTED VOLUME (`/dst`) from a throwaway container
 *     running as root, so it must chown what it creates;
 *   - cloud copies into the live box's real config dir as the box user, so it
 *     must not.
 * Everything else — which file, where it lands, which parent dirs to create —
 * comes from the registry, and a drift test pins the two plans together.
 */

import { resolveAgentSpec } from './registry.js';
import type { AgentId, AgentSeedSpec } from '@agentbox/core';

/** One resolved copy: absolute source, absolute destination, dirs to create. */
export interface AgentSeedPlacement {
  /**
   * Absolute source IN THE BOX. Normally the baked asset; the cloud path
   * substitutes an uploaded staging path when the base snapshot predates it.
   */
  src: string;
  /** Absolute destination. */
  dest: string;
  /**
   * Ancestor dirs of `dest` below the root, outermost first. Listed rather than
   * left to `mkdir -p` because ownership has to be fixed on EACH of them: a
   * root-run `mkdir -p a/b/c` leaves the intermediates root-owned, and the later
   * static-config stage then cannot write into them. That exact trap cost a live
   * DigitalOcean bake to find (see `SEED_SETUP_SKILL` in the registry).
   */
  ancestors: string[];
  /** Registry `destRel`, echoed as the success marker. */
  destRel: string;
  /** Human label for log lines. */
  label: string;
}

/** Join without importing node:path — these are always POSIX box paths. */
function boxJoin(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`;
}

/**
 * Resolve an agent's declared seeds against a root — `/dst` for the docker
 * volume mount, the agent's real `staticPaths[0].boxDir` for a live box.
 */
export function planAgentSeeds(
  seeds: readonly AgentSeedSpec[],
  root: string,
  opts: { srcFor?: (seed: AgentSeedSpec) => string } = {},
): AgentSeedPlacement[] {
  return seeds.map((seed) => {
    const parts = seed.destRel.split('/').filter((p) => p.length > 0);
    const dirs = parts.slice(0, -1);
    const ancestors: string[] = [];
    let acc = root.replace(/\/+$/, '');
    for (const d of dirs) {
      acc = `${acc}/${d}`;
      ancestors.push(acc);
    }
    return {
      src: opts.srcFor ? opts.srcFor(seed) : seed.bakedPath,
      dest: boxJoin(root, seed.destRel),
      ancestors,
      destRel: seed.destRel,
      label: seed.label,
    };
  });
}

/** An agent's declared seeds, resolved against its real in-box config dir. */
export function agentSeedPlacements(agent: AgentId, root?: string): AgentSeedPlacement[] {
  const spec = resolveAgentSpec(agent);
  const boxDir = root ?? spec.staticPaths[0]?.boxDir;
  if (!boxDir || !spec.seeds || spec.seeds.length === 0) return [];
  return planAgentSeeds(spec.seeds, boxDir);
}

/** Marker each successful copy prints, so callers can report what landed. */
export const AGENT_SEED_MARKER = 'AGENTBOX_SEEDED';

function shq(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell that performs the copies. Every step is guarded and the whole
 * per-seed group ends in `|| true`: a missing baked asset (older base image) is
 * a clean no-op, never a non-zero exit, because seeding must never fail a box
 * create. Always overwrites, so an image upgrade propagates instead of a stale
 * copy in a long-lived shared volume pinning the old version.
 *
 * `owner` (e.g. `vscode:vscode`) emits the chowns; omit it when the caller
 * already runs as the box user. By NAME, not uid — the vscode uid differs per
 * provider (docker/hetzner 1000, vercel 1001, e2b 1002).
 */
export function buildAgentSeedScript(
  placements: readonly AgentSeedPlacement[],
  opts: { owner?: string } = {},
): string {
  const groups = placements.map((p) => {
    const steps: string[] = [`[ -f ${shq(p.src)} ]`];
    for (const dir of p.ancestors) steps.push(`mkdir -p ${shq(dir)}`);
    steps.push(`cp -a ${shq(p.src)} ${shq(p.dest)}`);
    if (opts.owner) {
      for (const dir of p.ancestors) steps.push(`chown ${opts.owner} ${shq(dir)}`);
      steps.push(`chown ${opts.owner} ${shq(p.dest)}`);
    }
    steps.push(`echo ${shq(`${AGENT_SEED_MARKER} ${p.destRel}`)}`);
    return `{ ${steps.join(' && ')}; } || true`;
  });
  return groups.join('; ');
}

/** Which `destRel`s the script reported as copied. */
export function parseSeedMarkers(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (t.startsWith(`${AGENT_SEED_MARKER} `)) out.push(t.slice(AGENT_SEED_MARKER.length + 1));
  }
  return out;
}
