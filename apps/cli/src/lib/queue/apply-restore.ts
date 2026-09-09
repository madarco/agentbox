/**
 * The state half of a queued restore: put a backed-up bot's identity into the
 * box the worker just built.
 *
 * The workspace half needed no code here — `POST /projects/:id/restore` stages
 * the bundle's `workspace/` into a real directory and hands the create that
 * directory as its project, so it rides the ordinary create path untouched. The
 * state half cannot: it belongs inside the agent's own config dir, and the daemon
 * has to already own that dir before anything is written into it.
 *
 * Hence the ordering, which is the whole of the subtlety here and is NOT an
 * optimization to reorder: let the service come up ON ITS OWN first, then stop
 * it, then replace what it wrote. openclaw's `onboard` is a `run_once: marker`
 * task whose marker lives on the box ROOTFS rather than in the agent's config
 * volume, so it runs on every fresh box no matter what that volume holds — there
 * is no "write the state in before onboard" that works. Letting it run and then
 * overwriting means the marker is already down and onboard never touches the
 * restored identity again, on this boot or any later one.
 *
 * Mirrors what `runServiceAgent` does for the foreground `agentbox <agent>
 * --restore` path, against the same helpers, so the two cannot drift.
 */

import { join } from 'node:path';
import type { AgentSyncSpec, BoxRecord } from '@agentbox/core';
import { restoreAgentState } from '@agentbox/sandbox-core';
import { stopUnit, waitForService } from '../../agents/command/service-action.js';
import { pullTransportForBox } from '../../commands/_agent-pull-transport.js';
import { withOwningHub } from '../../control-plane/with-hub.js';

/** How long the worker waits for the service, on each of its two waits. */
const RESTORE_READY_TIMEOUT_S = 300;

export interface QueuedRestore {
  /** Absolute bundle dir (`…/bots/<bot>/<stamp>`) on this host. */
  bundleDir: string;
  /** The agent whose state dir the bundle carries. */
  agent: string;
}

/**
 * The agent spec a restore must run through, or a thrown error naming why there
 * isn't one.
 *
 * The two ways there is none both used to be silent `if` guards, and both ended
 * the same way: a job reported DONE, and a box running a **fresh** identity that
 * looks exactly like a restored one until someone tries to use it.
 *
 *  - no `spec`: the bundle's agent was removed from the registry between the
 *    enqueue and the run.
 *  - `startsSession`: a TUI agent that declares `stateBackup`. None does today,
 *    but `prepareRestore` would happily enqueue one, and this function is where
 *    that assumption is actually load-bearing — `applyQueuedRestore` needs a
 *    service to stop and restart.
 */
export function requireRestoreSpec(
  plan: { spec?: AgentSyncSpec; startsSession: boolean },
  restore: QueuedRestore,
): AgentSyncSpec {
  if (!plan.spec) {
    throw new Error(
      `cannot restore ${restore.agent} state: this host has no such agent installed, ` +
        `so the box was created with a fresh identity. Install it and restore again.`,
    );
  }
  if (plan.startsSession) {
    throw new Error(
      `cannot restore into a ${plan.spec.id} box: restore stops and restarts the agent's ` +
        `service, and ${plan.spec.id} runs as a session rather than a service.`,
    );
  }
  return plan.spec;
}

/**
 * Apply a restore to a freshly-created box. Throws on failure, so the job fails
 * loudly rather than reporting a box that came up with the WRONG identity —
 * which looks identical to a working one until someone tries to use it.
 */
export async function applyQueuedRestore(args: {
  box: BoxRecord;
  spec: AgentSyncSpec;
  restore: QueuedRestore;
  log: (line: string) => void;
}): Promise<void> {
  const { box, spec, restore, log } = args;
  const service = spec.service;
  if (!service) {
    throw new Error(`cannot restore into a ${spec.id} box: ${spec.id} declares no service`);
  }

  log(`waiting for ${service.name} before restoring ${restore.agent} state`);
  await waitForService(box, service.name, RESTORE_READY_TIMEOUT_S, log);

  log(`stopping ${service.name} to swap in the restored identity`);
  await stopUnit(box, service.name);

  const { transport } = await pullTransportForBox(box, restore.agent);
  const r = await restoreAgentState({
    agent: restore.agent,
    transport,
    srcDir: join(restore.bundleDir, 'state'),
  });
  log(
    `restored ${restore.agent} state (cleared ${String(r.clearedSidecars.length)} db sidecar(s))`,
  );

  await withOwningHub(box, async (client) => {
    await client.restartService(box.id, service.name);
  });
  await waitForService(box, service.name, RESTORE_READY_TIMEOUT_S, log);
  log(`${service.name} is back up on the restored identity`);
}
