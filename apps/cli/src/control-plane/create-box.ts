import type { CreateJobRequest } from '@agentbox/relay';

/**
 * The control-plane worker's box-creation step. The worker is a long-running
 * host (it runs the cloud poller for the boxes it makes), so instead of
 * cloning inside a serverless function it clones the repo LOCALLY with a leased
 * GitHub-App token and hands that fresh checkout to the normal, tested
 * `provider.create()` as the workspace — origin-clone seeding without touching
 * the host-coupled create flow. All side-effecting steps are injected so the
 * orchestration is unit-testable without a cloud or GitHub.
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

export function makeControlPlaneCreateBox(
  deps: CreateBoxDeps,
): (request: CreateJobRequest, jobId: string) => Promise<{ boxId: string }> {
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
