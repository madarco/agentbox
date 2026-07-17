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

/** Bound on the whole adopt round-trip. A miss must not stall the command. */
const ADOPT_TIMEOUT_MS = 4000;

/**
 * Try to adopt `ref` from the configured control box. Returns the freshly
 * recorded box, or null when there is no control box, it's unreachable, or it
 * doesn't know the ref.
 *
 * Imports its dependencies lazily: this runs on every by-name miss, including
 * on hosts with no control box at all, and the control-plane clients pull in
 * config + relay code that a plain `agentbox shell typo` shouldn't pay for.
 */
export async function tryAutoAdopt(ref: string, cwd: string): Promise<BoxRecord | null> {
  try {
    const { resolveCustodyTarget } = await import('../commands/control-plane.js');
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) return null;

    const [{ adoptHubBox }, { ControlPlaneAdminClient }, { CustodyClient }, { hostReachable }] =
      await Promise.all([
        import('./hub-adopt.js'),
        import('./admin-client.js'),
        import('./custody-client.js'),
        import('./hub-list.js'),
      ]);
    // See hub-list.ts: a fetch to an unreachable host can't be cancelled and
    // would hold the process open past the deadline. Probe with a socket we own.
    if (!(await hostReachable(target.url, ADOPT_TIMEOUT_MS))) return null;

    // Abort on the deadline rather than just losing the race: an un-awaited
    // fetch to an unreachable host holds its socket open and would keep the
    // whole command alive well past the timeout.
    const clientTarget = {
      ...target,
      fetchImpl: abortableFetch(ADOPT_TIMEOUT_MS),
    };
    const adopt = adoptHubBox({
      admin: new ControlPlaneAdminClient(clientTarget),
      custody: new CustodyClient(clientTarget),
      ref,
      controlPlaneUrl: target.url,
      cwd,
    });
    const res = await withTimeout(adopt, ADOPT_TIMEOUT_MS);
    return res?.record ?? null;
  } catch {
    // Unknown ref, unreachable control box, bad token — all indistinguishable
    // from "not a box" for the caller's purposes.
    return null;
  }
}

/** Wrap fetch so every request carries a hard `ms` abort deadline. */
function abortableFetch(ms: number): typeof fetch {
  return ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    fetch(url, { ...init, signal: AbortSignal.timeout(ms) })) as typeof fetch;
}

/** Resolve to null if `p` hasn't settled within `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
        // Don't hold the process open for the loser of the race.
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
