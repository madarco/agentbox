/**
 * Opportunistic by-name adoption of a control-box box.
 *
 * With a control box configured the PC is a thin client, so a box the user
 * refers to by name may exist only in the control box's registry (web-UI create
 * / `--via-hub`). Rather than teaching every box-arg command about the control
 * box, `resolveBoxOrExit` calls this on a local miss: one bounded round-trip
 * that materializes the local record, after which the normal resolve path finds
 * it and the command proceeds as if the box had been created here.
 *
 * Everything here is best-effort — no control box, no network, or an unknown
 * ref all return null and the caller falls back to its usual "no such box"
 * error. It must never turn an offline PC into a hang, hence the hard timeout.
 */
import type { BoxRecord } from '@agentbox/core';

/**
 * The adopted box, `'unreachable'` when the control box couldn't be asked, or
 * null when it was asked and doesn't know the ref.
 *
 * The distinction matters to the shift path: "no such box" is a fact it can act
 * on, while "couldn't ask" means any guess it makes might target the wrong box.
 */
export type AutoAdoptResult = BoxRecord | 'unreachable' | null;

/** Bound on the whole adopt round-trip. A miss must not stall the command. */
const ADOPT_TIMEOUT_MS = 4000;

/**
 * Bound on the "is the control box even up?" probe, which is deliberately much
 * tighter than the adopt budget: a TCP connect to a live host takes
 * milliseconds, so anything slower means it's effectively down. This is what a
 * DOWN control box costs, and `resolveBoxOrShift` runs it on tokens that are
 * usually a shell command (`agentbox shell npm run dev`) — spending the full
 * adopt budget there would make a routine command feel broken.
 */
const REACHABLE_PROBE_MS = 1500;

/**
 * Try to adopt `ref` from the configured control box. Returns the freshly
 * recorded box, or null when there is no control box, it's unreachable, or it
 * doesn't know the ref.
 *
 * Imports its dependencies lazily: this runs on every by-name miss, including
 * on hosts with no control box at all, and the control-plane clients pull in
 * config + relay code that a plain `agentbox shell typo` shouldn't pay for.
 */
export async function tryAutoAdopt(ref: string, cwd: string): Promise<AutoAdoptResult> {
  try {
    const { resolveCustodyTarget } = await import('../commands/control-plane.js');
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return null;

    const [
      { adoptHubBox },
      { ControlPlaneAdminClient },
      { CustodyClient },
      { deadlineFetch, hostReachable },
    ] = await Promise.all([
      import('./hub-adopt.js'),
      import('./admin-client.js'),
      import('./custody-client.js'),
      import('@agentbox/sandbox-cloud'),
    ]);
    // ONE budget for the whole attempt, spent down by each step — not a fresh
    // timeout per step, which would let the worst case run to a multiple of the
    // documented ceiling.
    const deadline = Date.now() + ADOPT_TIMEOUT_MS;
    const remaining = (): number => deadline - Date.now();

    // See hub-list.ts: a fetch to an unreachable host can't be cancelled and
    // would hold the process open past the deadline. Probe with a socket we own.
    //
    // `unreachable` is NOT `null`: a caller that would otherwise guess (the
    // shift path) must be able to tell "the control box says no such box" from
    // "the control box couldn't be asked".
    if (!(await hostReachable(target.url, Math.min(REACHABLE_PROBE_MS, remaining())))) {
      return 'unreachable';
    }
    if (remaining() <= 0) return 'unreachable';

    // One signal shared by every request, so the budget bounds the whole
    // adoption rather than each request separately. Aborting — rather than
    // racing and walking away — also means we never abandon an adoption that
    // then completes and writes state.json behind our back, which would surface
    // as "no box matches <ref>" for a box that now exists locally.
    const signal = AbortSignal.timeout(remaining());
    const clientTarget = { ...target, fetchImpl: deadlineFetch(signal) };
    const res = await adoptHubBox({
      admin: new ControlPlaneAdminClient(clientTarget),
      custody: new CustodyClient(clientTarget),
      ref,
      controlPlaneUrl: target.url,
      cwd,
    });
    return res.record;
  } catch (err) {
    // Only the control box answering "no such box" is a definitive miss. A
    // network failure, an expired budget, or a bad token mean we never got an
    // answer — say so, rather than let a caller read it as "not a box".
    //
    // Matched by name, not `instanceof`: importing the class would pull
    // hub-adopt.js eagerly and defeat this module's lazy loading.
    if (err instanceof Error && err.name === 'HubBoxNotFoundError') return null;
    return 'unreachable';
  }
}
