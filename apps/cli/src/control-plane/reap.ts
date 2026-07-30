/**
 * Reap a destroyed box's state from the control box.
 *
 * Tearing down the cloud resource is only half the job when a control box is
 * configured: the box is also a row in the plane's registry (plus a status row
 * and an SSH-key subtree in custody). Without this, a box destroyed from the PC
 * lingers as a ghost in `agentbox ls`, the hub web UI, and the tray.
 *
 * Deliberately best-effort. The local destroy has already happened and cannot be
 * undone, so an unreachable control box must never fail the command — the caller
 * warns and points at `agentbox hub boxes rm <id>` as the manual follow-up.
 */
import type { BoxRecord } from '@agentbox/core';
import { resolveBoxPlane } from './box-plane.js';

/**
 * - `reaped`      — the control box removed the registration (and/or custody keys).
 * - `absent`      — it answered, and had nothing under that id (already clean).
 * - `skipped`     — nothing to ask: a docker box, or no control box configured.
 * - `unreachable` — a control box IS configured but we couldn't get an answer.
 */
export type ReapOutcome = 'reaped' | 'absent' | 'skipped' | 'unreachable';

/** Bound on the whole reap round-trip, matching `tryAutoAdopt`'s budget. */
const REAP_TIMEOUT_MS = 4000;

/** Tighter probe: a TCP connect to a live host is milliseconds. See auto-adopt.ts. */
const REACHABLE_PROBE_MS = 1500;

/**
 * Remove `box`'s registration + status + SSH-key custody from the control box it
 * registered with. Never throws. See {@link resolveBoxPlane} for which plane
 * that is (a docker box resolves to `none` and is skipped — it never registers
 * on one).
 *
 * Imports lazily: this runs on every destroy, including on hosts with no control
 * box, and the control-plane clients pull in config + relay code that a plain
 * `agentbox destroy` shouldn't pay for.
 */
export async function reapOnControlBox(box: BoxRecord): Promise<ReapOutcome> {
  try {
    const target = await resolveBoxPlane(box);
    if (target === 'none') return 'skipped';
    if (target === 'no-token') return 'unreachable';

    const { deadlineFetch, hostReachable } = await import('@agentbox/sandbox-cloud');
    const { ControlPlaneAdminClient } = await import('./admin-client.js');

    // One budget for the whole attempt, spent down by each step.
    const deadline = Date.now() + REAP_TIMEOUT_MS;
    const remaining = (): number => deadline - Date.now();
    // A fetch to an unreachable host can't be cancelled and would hold the
    // process open past the deadline; probe with a socket we own first.
    if (!(await hostReachable(target.url, Math.min(REACHABLE_PROBE_MS, remaining()))))
      return 'unreachable';
    if (remaining() <= 0) return 'unreachable';

    const client = new ControlPlaneAdminClient({
      ...target,
      fetchImpl: deadlineFetch(AbortSignal.timeout(remaining())),
    });
    const res = await client.reapBox(box.id);
    return res.removed || res.custodyRemoved > 0 ? 'reaped' : 'absent';
  } catch {
    return 'unreachable';
  }
}

// `reapSandboxesOnControlBox` (orphan-cloud-sandbox reaping for `prune --provider
// <cloud>`) moved server-side into the hub's `POST /api/v1/prune` route (Step 9):
// the hub deletes the orphan then reaps its own Store registration directly, so
// the CLI no longer round-trips the /admin reap wire.
