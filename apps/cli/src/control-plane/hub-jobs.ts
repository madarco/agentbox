/**
 * The control box's create queue, as seen from the PC.
 *
 * With a control box configured, background `-i` cloud runs are enqueued THERE
 * rather than in `~/.agentbox/queue/` — so `agentbox queue list`, which reads
 * only the local queue, was showing an incomplete picture of what is running.
 *
 * Bounded like `fetchHubListing`: `queue list` is interactive, so an unreachable
 * control box must cost a fixed, small amount of time and degrade to a note
 * rather than an error.
 */
import { deadlineFetch, hostReachable } from '@agentbox/sandbox-cloud';
import type { CreateJobRow } from '@agentbox/relay/control-plane';
import { listHubJobs } from './hub-enqueue.js';

/** Bound on the whole lookup. Matches `fetchHubListing`'s interactive budget. */
const HUB_JOBS_TIMEOUT_MS = 1500;

export type HubJobsResult =
  /** No control box configured — the local queue is the whole story. */
  | { kind: 'none' }
  | { kind: 'ok'; jobs: CreateJobRow[] }
  /** Configured, but we couldn't get an answer (down, slow, no token, too old). */
  | { kind: 'unavailable'; reason: string };

/**
 * Fetch the control box's create jobs. Never throws.
 *
 * A `501` means the control box predates the listing route; report that plainly
 * rather than as a generic failure, since it's fixed by redeploying the hub.
 */
export async function fetchHubJobs(): Promise<HubJobsResult> {
  try {
    const { resolveCustodyTarget } = await import('../commands/control-plane.js');
    const target = await resolveCustodyTarget(undefined, { quiet: true });
    if (!target) {
      const { loadEffectiveConfig } = await import('@agentbox/config');
      const { remoteHubConfigured } = await import('./remote-hub.js');
      const configured = await loadEffectiveConfig(process.cwd())
        .then((c) => remoteHubConfigured(c.effective))
        .catch(() => false);
      return configured
        ? { kind: 'unavailable', reason: 'no admin token — run `agentbox hub setup`' }
        : { kind: 'none' };
    }

    const deadline = Date.now() + HUB_JOBS_TIMEOUT_MS;
    const remaining = (): number => deadline - Date.now();
    // See hub-list.ts: a fetch to an unreachable host can't be cancelled, so
    // probe with a socket we own before spending the rest of the budget.
    if (!(await hostReachable(target.url, remaining()))) {
      return { kind: 'unavailable', reason: 'control box unreachable' };
    }
    if (remaining() <= 0) return { kind: 'unavailable', reason: 'control box unreachable' };

    const jobs = await listHubJobs({
      ...target,
      fetchImpl: deadlineFetch(AbortSignal.timeout(remaining())),
    });
    return { kind: 'ok', jobs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // 501 = the plane's store has no queue; 405 = a control box deployed before
    // this route existed, where GET on the prefix falls through to
    // method-not-allowed. Both mean "the hub can't answer", not "we're offline".
    if (msg.includes('501') || msg.includes('405')) {
      return {
        kind: 'unavailable',
        reason: 'this control box has no job-listing route — redeploy the hub',
      };
    }
    return { kind: 'unavailable', reason: 'control box unreachable' };
  }
}
