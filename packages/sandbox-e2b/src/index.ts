/**
 * The E2B sandbox provider. A thin `CloudBackend` over the `e2b` v2 SDK,
 * composed via `@agentbox/sandbox-cloud`'s `createCloudProvider` for
 * everything provider-agnostic (workspace seeding, ctl launch, state, relay
 * polling).
 *
 * Task 1 overrides only the checkpoint capability — and only with a stub that
 * throws. Real checkpoints (template-snapshot semantics) land in Task 2 along
 * with `prepare` (`e2b template build` from a Dockerfile) and the SDK
 * streaming attach helper.
 *
 * `launchDockerd: false` because E2B microVMs can't run nested containers.
 */

import type { AttachSpec, Provider, ProviderCheckpoint } from '@agentbox/core';
import { createCloudProvider } from '@agentbox/sandbox-cloud';
import { e2bBackend, DEFAULT_BOX_IMAGE_REF } from './backend.js';

const cloudProvider = createCloudProvider(e2bBackend, {
  // E2B base template defaults are 2 vCPU / 4 GiB RAM / 8 GiB disk. Custom
  // resources are template-level (set in `Template.build({ cpuCount, memoryMB })`)
  // not per-create; these numbers feed BoxRecord stats for the dashboard and
  // are advisory until Task 2's `prepare` bakes a sized template.
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
  launchDockerd: false,
});

/**
 * Task 1 checkpoint stub. E2B's persistence primitive (`Sandbox.pause` +
 * `Sandbox.connect` auto-resume) is a single-resume cold store, not a
 * reusable immutable image — true checkpoints require a `Template.build`
 * snapshot, which lands in Task 2. Until then, surfaces a clear error rather
 * than silently no-op'ing.
 */
const e2bCheckpointStub: ProviderCheckpoint = {
  async create() {
    throw new Error(
      'agentbox checkpoint create: not yet implemented for e2b (Task 2 — see docs/e2b_backlog.md).',
    );
  },
  async list() {
    return [];
  },
  async remove() {
    /* no-op: Task 1 has no checkpoints to remove. */
  },
};

/**
 * Task 1 attach stub. The cloud scaffold's default `buildAttach` would call
 * `backend.attachArgv` (E2B has no SSH so it omits it) and throw a generic
 * "interactive attach not supported" mid-flow — including from the post-create
 * wizard hand-off and the dashboard cloud pane. Override here so the failure
 * mode is a single clear, Task-2-tagged error at the only entry point that
 * matters (`agentbox shell` / `claude` / `codex` / `opencode` against an e2b
 * box). Task 2 will replace this with an SDK-streaming tmux bridge (mirrors
 * vercel's `buildVercelAttach`).
 */
async function e2bAttachNotImplemented(): Promise<AttachSpec> {
  throw new Error(
    'agentbox attach: interactive attach not yet implemented for e2b (Task 2 — see docs/e2b_backlog.md). ' +
      'Use `agentbox e2b login --status`, `agentbox list`, `agentbox url <box>`, or destroy/recreate in the meantime.',
  );
}

export const e2bProvider: Provider = {
  ...cloudProvider,
  checkpoint: e2bCheckpointStub,
  buildAttach: e2bAttachNotImplemented,
};

export { e2bBackend, DEFAULT_BOX_IMAGE_REF };
export { ensureE2bEnvLoaded, reloadE2bEnv } from './env-loader.js';
export {
  ensureE2bCredentials,
  readE2bCredStatus,
  secretsPath,
  maskKey,
  type EnsureE2bCredentialsOptions,
  type E2bCredStatus,
} from './credentials.js';
export {
  RUNTIME_ASSETS,
  candidatesFor,
  resolveRuntimeAssets,
  findStagedCliRuntimeRoot,
  type RuntimeAsset,
  type ResolvedAsset,
} from './runtime-assets.js';
