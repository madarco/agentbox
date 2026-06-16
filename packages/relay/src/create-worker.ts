import type { CreateJobRequest, Store } from './store/store.js';

/**
 * The actual box-creation step, injected by the deploy target. On a self-host
 * worker / Vercel cron this provisions a cloud box and seeds its workspace by
 * cloning `request.repoUrl` with a leased GitHub-App token (origin-clone — no
 * host bundle). Kept injectable so the worker loop is unit-testable without a
 * live cloud, and so the heavy provider wiring lives outside the relay core.
 */
export type CreateBoxFn = (request: CreateJobRequest, jobId: string) => Promise<{ boxId: string }>;

/**
 * Claim + run ONE queued create job. Returns the processed job id, or null when
 * the queue is empty (or the store has no create-job support). A throwing
 * `createBox` marks the job failed (never throws out of here).
 */
export async function drainOneCreateJob(
  store: Store,
  createBox: CreateBoxFn,
  workerId: string,
): Promise<string | null> {
  if (!store.claimNextCreateJob || !store.completeCreateJob) return null;
  const job = await store.claimNextCreateJob(workerId);
  if (!job) return null;
  try {
    const { boxId } = await createBox(job.request, job.id);
    await store.completeCreateJob(job.id, 'done', { boxId });
  } catch (err) {
    await store.completeCreateJob(job.id, 'failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return job.id;
}

/**
 * Drain queued create jobs until the queue is empty or `max` is hit. Used by
 * the self-host worker loop and a Vercel cron tick. Returns the count processed.
 */
export async function drainCreateJobs(
  store: Store,
  createBox: CreateBoxFn,
  workerId: string,
  max = 10,
): Promise<number> {
  let processed = 0;
  while (processed < max) {
    const id = await drainOneCreateJob(store, createBox, workerId);
    if (!id) break;
    processed++;
  }
  return processed;
}
