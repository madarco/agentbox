/**
 * Bake a provider's base ON the control box, from this machine.
 *
 * With `cloud.viaHub` on, a cloud box is created on the control box and built
 * from ITS prepared state — so a bake run here is minutes spent producing a
 * snapshot nothing will boot, and the two sides then disagree about what the
 * base is. Baking there and adopting the record back gives one bake, one
 * snapshot, and both machines current.
 *
 * The hub already exposes everything this needs (`POST /api/v1/providers/:id/prepare`,
 * `GET /api/v1/jobs/:id`, `GET /api/v1/jobs/:id/logs`); nothing new on that side.
 */
import { pullPreparedFromCustody } from '@agentbox/sandbox-cloud';
import type { Provider } from '@agentbox/core';
import { HubApiError, type HubApiClient } from './hub-api-client.js';
import { pinAdoptedBase } from './prepared-custody.js';

/** How often the job's terminal status is re-checked while the log streams. */
const JOB_POLL_MS = 3000;
/**
 * Cap on a single bake. Generous: a cold daytona/e2b image build is genuinely
 * ~10 minutes, and a bake that outlives this is still running on the hub — the
 * user is told where to watch it rather than left with a hung terminal.
 */
const BAKE_TIMEOUT_MS = 45 * 60_000;

export type HubBakeOutcome =
  /** The hub baked it and we adopted the record — nothing left to do here. */
  | { status: 'adopted' }
  /** The hub baked it, but its record didn't reach our prepared-state. */
  | { status: 'baked-not-adopted'; detail: string }
  | { status: 'failed'; detail: string };

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run a bake on the control box and adopt the resulting record.
 *
 * The log stream is advisory — a dropped connection must never read as a
 * successful bake — so the verdict always comes from polling the job itself.
 */
export async function bakeOnControlBox(args: {
  client: HubApiClient;
  providerName: string;
  provider: Provider;
  force?: boolean;
  claudeInstall: 'native' | 'npm';
  custody: { url: string; adminToken: string } | null;
  onLog: (line: string) => void;
}): Promise<HubBakeOutcome> {
  let jobId: string;
  try {
    jobId = await args.client.prepareProvider(args.providerName, {
      force: args.force,
      claudeInstall: args.claudeInstall,
    });
  } catch (err) {
    // A precheck failure on the hub (no credentials there, docker down) is a
    // 409 with a real message — surface it verbatim rather than as "failed".
    const detail =
      err instanceof HubApiError ? err.message : err instanceof Error ? err.message : String(err);
    return { status: 'failed', detail };
  }

  const abort = new AbortController();
  // Fire-and-forget: the stream ends when the hub closes it. Errors are ignored
  // on purpose — losing the log must not lose the bake.
  const streaming = args.client
    .streamJobLog(jobId, args.onLog, abort.signal)
    .catch(() => undefined);

  const deadline = Date.now() + BAKE_TIMEOUT_MS;
  let status = 'queued';
  try {
    for (;;) {
      await delay(JOB_POLL_MS);
      const job = await args.client.getJob(jobId).catch(() => null);
      // A job that vanished (hub restarted mid-bake) is not a success.
      if (!job) {
        status = 'gone';
        break;
      }
      status = job.status;
      if (status === 'done' || status === 'failed' || status === 'cancelled') break;
      if (Date.now() > deadline) {
        return {
          status: 'failed',
          detail: `the bake is still running on the control box after ${String(Math.round(BAKE_TIMEOUT_MS / 60_000))} minutes — watch job ${jobId} there`,
        };
      }
    }
  } finally {
    abort.abort();
    await streaming;
  }

  if (status !== 'done') {
    return { status: 'failed', detail: `the control box's bake job ${jobId} ended ${status}` };
  }

  // The hub's bake wrote its record into custody (`sharePreparedBase` →
  // `writePreparedToCustodyStore`), so adopting is a plain custody read.
  if (!args.custody) {
    return {
      status: 'baked-not-adopted',
      detail: 'no control-box admin token, so its bake record could not be read back',
    };
  }
  const fingerprint = await Promise.resolve(args.provider.baseFingerprint?.('native')).catch(
    () => undefined,
  );
  const res = await pullPreparedFromCustody(args.providerName, fingerprint, {
    controlPlaneUrl: args.custody.url,
    adminToken: args.custody.adminToken,
    log: args.onLog,
  }).catch(() => ({ adopted: false, record: undefined }));
  if (!res.adopted) {
    return {
      status: 'baked-not-adopted',
      detail: `the control box baked ${args.providerName}, but its record does not match this machine's build context`,
    };
  }
  // Same pin a local bake writes: some providers (daytona) resolve their base
  // from `box.image<Provider>`, not from prepared-state.
  await pinAdoptedBase(args.providerName, res.record, args.onLog);
  return { status: 'adopted' };
}
