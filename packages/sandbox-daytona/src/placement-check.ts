import { DAYTONA_VM_REGION } from '@agentbox/config';
import type { PlacementCheck } from '@agentbox/sandbox-core';

/**
 * Can a box boot from the base `snapshot` in `region`? Size never enters: it
 * is fixed at bake time on the snapshot path (`sizeIgnoredReason` covers it).
 *
 * Two facts decide it: a linux-vm base runs only in us-east-1, and a snapshot
 * lists the regions it was built in (`regionIds`; a container base baked
 * against the account default reported ["us"] from every client, measured
 * 2026-11-28). An unknown `regionIds` says nothing, so it passes.
 */
export function daytonaPlacementVerdict(q: {
  region: string;
  snapshot: string;
  sandboxClass?: string;
  regionIds?: unknown;
}): PlacementCheck {
  const { region, snapshot } = q;
  if (q.sandboxClass === 'linux-vm' && region !== DAYTONA_VM_REGION) {
    return {
      offered: false,
      reason:
        `The daytona base is a linux-vm snapshot, which runs only in ${DAYTONA_VM_REGION}, not ` +
        `'${region}'. To use another region, re-bake it as a container: ` +
        `agentbox config set box.daytonaClass container, then ` +
        `agentbox prepare --provider daytona --force --location ${region}.`,
    };
  }
  const ids = q.regionIds;
  if (Array.isArray(ids) && ids.length > 0 && !ids.includes(region)) {
    return {
      offered: false,
      reason:
        `The daytona base snapshot '${snapshot}' exists in ${ids.join(', ')}, not in '${region}'. ` +
        `Bake one there first: agentbox prepare --provider daytona --force --location ${region}.`,
    };
  }
  return { offered: true };
}
