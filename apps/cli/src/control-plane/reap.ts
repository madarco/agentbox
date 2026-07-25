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


/**
 * Reap the registrations of orphan cloud sandboxes that `prune --provider <p>`
 * just deleted. Those were never in local state, so there is no `BoxRecord` and
 * no box id — only the provider's sandbox id. The registry carries `sandboxId`,
 * so map through it and reap the matching rows.
 *
 * Returns how many were reaped; 0 (never a throw) when there is no control box,
 * it can't be reached, or none of the sandboxes were registered on it.
 */
export async function reapSandboxesOnControlBox(sandboxIds: string[]): Promise<number> {
  if (sandboxIds.length === 0) return 0;
  try {
    const { resolveCustodyTarget } = await import('../commands/control-plane.js');
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return 0;


    const [{ ControlPlaneAdminClient }, { deadlineFetch, hostReachable }] = await Promise.all([
      import('./admin-client.js'),
      import('@agentbox/sandbox-cloud'),
    ]);
    if (!(await hostReachable(target.url, REACHABLE_PROBE_MS))) return 0;

    // A prune can span many sandboxes, so budget per box rather than for the
    // whole sweep — one slow reap shouldn't cancel the rest.
    const client = new ControlPlaneAdminClient({
      ...target,
      fetchImpl: deadlineFetch(AbortSignal.timeout(REAP_TIMEOUT_MS)),
    });
    const wanted = new Set(sandboxIds);
    const registrations = await client.listBoxes();
    const doomed = registrations.filter((r) => r.sandboxId && wanted.has(r.sandboxId));

    let reaped = 0;
    for (const reg of doomed) {
      const perBox = new ControlPlaneAdminClient({
        ...target,
        fetchImpl: deadlineFetch(AbortSignal.timeout(REAP_TIMEOUT_MS)),
      });
      const res = await perBox.reapBox(reg.boxId).catch(() => null);
      if (res && (res.removed || res.custodyRemoved > 0)) reaped += 1;
    }
    return reaped;
  } catch {
    return 0;
  }
}
