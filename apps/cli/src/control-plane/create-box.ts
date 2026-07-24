/**
 * The control-plane worker's box-creation orchestration now lives in
 * `@agentbox/relay` (`create-worker.ts`) so BOTH the laptop `control-plane
 * worker` command and the resident hub worker can build a `CreateBoxFn` from it
 * (an app can't import another app). Re-exported here for the CLI's callers.
 */
export { makeControlPlaneCreateBox, cloneRepoWithLfs, type CreateBoxDeps } from '@agentbox/relay';
