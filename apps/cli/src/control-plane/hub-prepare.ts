/**
 * Bake a provider's base THROUGH the hub, from this machine — the one prepare
 * path, local hub or remote control box alike (`docs/hub-api-single-path-plan.md`
 * Step 1). The hub runs the bake in its own queue worker; this drives it and
 * reports the verdict.
 *
 * Two shapes, decided by whether the hub is co-located with this CLI:
 *   - **Co-located** (a local hub, or `hub expose` on this machine): the worker
 *     writes the prepared-state to THIS machine's `~/.agentbox` directly, so
 *     there is nothing to adopt — a `done` job is the whole story.
 *   - **Remote control box**: the worker wrote the record to ITS disk + custody;
 *     we pull it back so both machines end up current from one bake. (With
 *     `cloud.viaHub`, a cloud box is also built there, so baking there is where
 *     the snapshot needs to live anyway.)
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
  /**
   * The hub baked it and the result is current on THIS machine — either a
   * co-located hub wrote the prepared-state here directly, or we adopted a remote
   * control box's record. Nothing left to do.
   */
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
export async function bakeViaHub(args: {
  client: HubApiClient;
  providerName: string;
  provider: Provider;
  force?: boolean;
  claudeInstall: 'native' | 'npm';
  /**
   * Bake INPUTS threaded from the CLI's flags (`--build` / `--size` / `--location`
   * / `--name`). They ride the same route body; the hub worker fills any that are
   * absent from its own effective config. Not routing — see the plan's Step 1.
   */
  build?: boolean;
  size?: string;
  location?: string;
  name?: string;
  custody: { url: string; adminToken: string } | null;
  /**
   * Whether the hub runs on THIS machine (a local hub, or `hub expose`). When
   * true, the worker's prepared-state write already lands in this machine's
   * `~/.agentbox`, so there is no custody round-trip to adopt.
   */
  coLocated: boolean;
  /**
   * remote-docker only: the host alias to bake. It goes to a different endpoint
   * (`/hosts/:alias/bake`), because the unit of a remote-docker base is a host,
   * not the provider — there is no single `remote-docker` base to prepare.
   */
  remoteHost?: string;
  onLog: (line: string) => void;
}): Promise<HubBakeOutcome> {
  let jobId: string;
  try {
    jobId = args.remoteHost
      ? await args.client.bakeHost(args.remoteHost)
      : await args.client.prepareProvider(args.providerName, {
          force: args.force,
          claudeInstall: args.claudeInstall,
          build: args.build,
          size: args.size,
          location: args.location,
          name: args.name,
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
  // The failed job's own reason. Without it the caller only ever learned that a
  // job "ended failed" and had to go read the hub's log to find out why — so
  // every bake failure, however precisely diagnosed on the hub side, reached the
  // user as an opaque line plus a stack trace. `create` already surfaces this
  // field; `prepare` was throwing it away.
  let jobError: string | undefined;
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
      jobError = job.error;
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
    const reason = jobError?.trim();
    return {
      status: 'failed',
      detail: reason
        ? `${reason}\n  (control box bake job ${jobId} ended ${status})`
        : `the control box's bake job ${jobId} ended ${status}`,
    };
  }

  // A remote-docker bake put the image on the REMOTE HOST, which this machine
  // reaches too, and "is that host baked?" is answered by asking its engine —
  // never by a local file. So there is nothing to adopt, and nothing to pin.
  // (The local `remote-docker-prepared.json` history stays silent about a bake
  // this machine didn't run; that file is explicitly a log for `prepare
  // --status` / `doctor`, not the readiness check.)
  if (args.remoteHost) return { status: 'adopted' };

  // Co-located hub (local, or `hub expose`): the worker wrote the prepared-state
  // straight into this machine's `~/.agentbox` and pinned the config, so a `done`
  // job means the base is already current here. No custody round-trip.
  if (args.coLocated) return { status: 'adopted' };

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
