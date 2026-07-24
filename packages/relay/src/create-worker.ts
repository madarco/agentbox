import type { CreateJobRequest, Store } from './store/store.js';

/**
 * The actual box-creation step, injected by the deploy target. On a self-host
 * worker / Vercel cron this provisions a cloud box and seeds its workspace by
 * cloning `request.repoUrl` with a leased GitHub-App token (origin-clone — no
 * host bundle). Kept injectable so the worker loop is unit-testable without a
 * live cloud, and so the heavy provider wiring lives outside the relay core.
 */
export type CreateBoxFn = (
  request: CreateJobRequest,
  jobId: string,
) => Promise<{ boxId: string; agentStartError?: string }>;

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
  /**
   * Provision the cloud box from the local checkout. Returns the new box id, and
   * `agentStartError` when the box was created but starting the agent in-box
   * failed (a background `-i` run) — the caller fails the job WITH the box id so
   * the box is preserved for adopt/attach.
   */
  createBox(opts: {
    workspacePath: string;
    name: string | undefined;
    provider: string;
    /**
     * Agent the box is being created for. Registered on the control plane so a
     * PC adopting this box knows which agent to relaunch. When `prompt` is set
     * the worker also STARTS this agent detached in the box.
     */
    agent?: string;
    /** Seed prompt for a background `-i` run — present ⇒ start the agent in-box. */
    prompt?: string;
    /** Fully-processed agent args (post-`--`, incl. skip-permissions). */
    agentArgs?: string[];
    onLog?: (line: string) => void;
  }): Promise<{ id: string; agentStartError?: string }>;
  /** Make a per-job temp dir path. */
  tmpDir(jobId: string): string;
  /** Remove the temp checkout (best-effort). */
  cleanup(dir: string): Promise<void>;
  /**
   * Overlay the project's custody seed material (untracked files + env/secrets
   * a PC pushed) onto the fresh checkout at `dest`. A clone can only ever carry
   * committed state, so without this a hub-created box is missing exactly the
   * local files that make the project runnable.
   *
   * Optional and best-effort: a worker with no custody store (or a project that
   * was never pushed) simply creates the box from the bare clone, as before.
   * Returns what it applied, for the job log.
   */
  fetchSeedMaterial?(
    repoUrl: string,
    dest: string,
  ): Promise<{ files: number; capturedAt?: string; repoHeadSha?: string } | null>;
  log?: (line: string) => void;
}

/** Runs `git <args>` with optional extra env + timeout; rejects on non-zero. */
export type CloneRepoRunGit = (
  args: string[],
  env?: Record<string, string>,
  timeoutMs?: number,
) => Promise<void>;

/** The GitHub/GitLab-convention LFS API endpoint for a clone URL: `<repo>.git/info/lfs`. */
function lfsEndpointFor(cloneUrl: string): string {
  return `${cloneUrl.replace(/\.git$/, '')}.git/info/lfs`;
}

/**
 * Clone `authedUrl` into `dest` robustly against **git-LFS**. A worker (control
 * box / laptop) clones with a leased token, and LFS reuses that token over HTTPS
 * (the standard CI path — verified). But the worker's git environment can resolve
 * an *SSH* LFS batch endpoint — e.g. a `git@github.com: insteadOf` rewrite (the
 * git-identity seeding configures such rewrites) makes git-lfs try SSH — and then
 * it hard-fails the create at the smudge step (`ssh_askpass ... Host key
 * verification failed`). To make the LFS fetch deterministic over HTTPS:
 *  1. clone with `GIT_LFS_SKIP_SMUDGE=1` — the checkout comes down with LFS
 *     **pointer files**, so the clone can't fail on LFS transport at all;
 *  2. `git lfs pull` with `lfs.url` FORCED to the authed HTTPS endpoint — the
 *     embedded `x-access-token:<token>@` userinfo both authenticates the fetch
 *     AND dodges an `https://github.com/ → ssh` insteadOf rewrite (that prefix no
 *     longer matches once the userinfo is present), so the real bytes come down
 *     over HTTPS. Best-effort + non-interactive + timed: a token that genuinely
 *     can't read LFS is left as pointers with a log line, not a failed create;
 *  3. scrub the leased token from `origin` (leave the box on the bare repo URL).
 *
 * Shared by both worker impls (`apps/hub` resident worker, `apps/cli control-plane
 * worker`) via an injected git-runner so it stays runtime-agnostic.
 */
export async function cloneRepoWithLfs(
  runGit: CloneRepoRunGit,
  authedUrl: string,
  repoUrl: string,
  dest: string,
  branch?: string,
  log: (line: string) => void = () => {},
): Promise<void> {
  await runGit(branch ? ['clone', '--branch', branch, authedUrl, dest] : ['clone', authedUrl, dest], {
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  // Fetch the real LFS bytes over the forced HTTPS endpoint (best-effort). A repo
  // with no LFS makes this a fast no-op. `-c lfs.url` overrides remote/insteadOf
  // resolution; the token is passed on the argv (ephemeral), never written to the
  // box's config — origin is scrubbed to the bare URL below regardless.
  try {
    await runGit(
      ['-C', dest, '-c', `lfs.url=${lfsEndpointFor(authedUrl)}`, 'lfs', 'pull'],
      { GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=no' },
      120_000,
    );
  } catch (err) {
    log(`git-lfs objects left as pointers (fetch failed): ${err instanceof Error ? err.message : String(err)}`);
  }
  await runGit(['-C', dest, 'remote', 'set-url', 'origin', repoUrl]);
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
      if (deps.fetchSeedMaterial) {
        try {
          const seed = await deps.fetchSeedMaterial(request.repoUrl, dir);
          if (seed && seed.files > 0) {
            // Report what the seed was captured from: it can lag the branch tip
            // (the PC pushes it on create), and a surprising box is much easier
            // to explain when the job log says how old its local files are.
            const from = [
              seed.repoHeadSha ? `at ${seed.repoHeadSha.slice(0, 8)}` : null,
              seed.capturedAt ? `captured ${seed.capturedAt}` : null,
            ]
              .filter(Boolean)
              .join(', ');
            log(`applied ${String(seed.files)} seed file(s) from custody${from ? ` (${from})` : ''}`);
          }
        } catch (err) {
          // The box is still usable without the user's local files — say so and
          // carry on rather than failing a create the user is waiting on.
          log(
            `seed material unavailable (continuing with a bare clone): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      log(`provisioning ${request.provider} box from the clone`);
      const box = await deps.createBox({
        workspacePath: dir,
        name: request.name,
        provider: request.provider,
        // Carry the job's agent through to the box record + its plane
        // registration, so an adopting PC relaunches the right agent instead of
        // guessing. Without this a hub-created box adopts with no `lastAgent`.
        agent: request.agent,
        // A background `-i` run seeds a prompt: the worker starts the agent
        // in-box with these. Absent ⇒ a "cold" create (create --via-hub /
        // foreground) that the PC attaches later.
        prompt: request.prompt,
        agentArgs: request.agentArgs,
        onLog: deps.log,
      });
      log(`created box ${box.id}`);
      return { boxId: box.id, agentStartError: box.agentStartError };
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
    const { boxId, agentStartError } = await createBox(job.request, job.id);
    // The box was created; if starting the agent in-box failed, fail the job but
    // keep the box id so it's adoptable/attachable (the user re-logins + retries).
    if (agentStartError) {
      await store.completeCreateJob(job.id, 'failed', { boxId, error: agentStartError });
    } else {
      await store.completeCreateJob(job.id, 'done', { boxId });
    }
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
