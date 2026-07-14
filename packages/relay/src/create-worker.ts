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
 * Side-effecting steps a {@link makeControlPlaneCreateBox} needs, all injected
 * so the orchestration is unit-testable without a cloud or GitHub. The worker
 * (laptop `control-plane worker`, or the resident hub worker) clones the repo
 * LOCALLY with a leased GitHub-App token and hands the fresh checkout to the
 * normal, tested `provider.create()` as the workspace — origin-clone seeding
 * without touching the host-coupled create flow.
 */
export interface CreateBoxDeps {
  /** Mint an authed HTTPS remote URL for the repo (App lease → x-access-token URL). */
  leaseRemoteUrl(repoUrl: string): Promise<string>;
  /**
   * Clone `authedUrl` into `dest` (checking out `branch` when given), then scrub
   * the remote back to the bare `repoUrl`.
   */
  cloneRepo(authedUrl: string, repoUrl: string, dest: string, branch?: string): Promise<void>;
  /** Provision the cloud box from the local checkout. Returns the new box id. */
  createBox(opts: {
    workspacePath: string;
    name: string | undefined;
    provider: string;
    onLog?: (line: string) => void;
  }): Promise<{ id: string }>;
  /** Make a per-job temp dir path. */
  tmpDir(jobId: string): string;
  /** Remove the temp checkout (best-effort). */
  cleanup(dir: string): Promise<void>;
  log?: (line: string) => void;
}

/**
 * Build a {@link CreateBoxFn} from injected side-effecting steps: lease a push
 * token, clone the repo locally, provision the box from that checkout, clean up.
 */
export function makeControlPlaneCreateBox(deps: CreateBoxDeps): CreateBoxFn {
  return async (request, jobId) => {
    const log = deps.log ?? (() => {});
    const dir = deps.tmpDir(jobId);
    try {
      log(`leasing a push token for ${request.repoUrl}`);
      const authedUrl = await deps.leaseRemoteUrl(request.repoUrl);
      log(`cloning ${request.repoUrl}${request.branch ? `@${request.branch}` : ''} into ${dir}`);
      await deps.cloneRepo(authedUrl, request.repoUrl, dir, request.branch);
      log(`provisioning ${request.provider} box from the clone`);
      const box = await deps.createBox({
        workspacePath: dir,
        name: request.name,
        provider: request.provider,
        onLog: deps.log,
      });
      log(`created box ${box.id}`);
      return { boxId: box.id };
    } finally {
      await deps.cleanup(dir);
    }
  };
}

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
