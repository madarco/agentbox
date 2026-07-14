/**
 * `agentbox create --via-hub`: instead of creating a box locally, enqueue a
 * create job on the control box (`POST /remote/boxes`) and stream its progress
 * (`GET /remote/boxes/:id`). The resident hub worker claims the job and
 * provisions the box VPS-side, so a box can be created with the PC's providers
 * unconfigured (or the PC off after the enqueue).
 */

import type { CreateJobRequest, CreateJobRow } from '@agentbox/relay/control-plane';

export interface HubTarget {
  url: string;
  adminToken: string;
  fetchImpl?: typeof fetch;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** Enqueue a create job; returns the job id. */
export async function enqueueCreateViaHub(target: HubTarget, request: CreateJobRequest): Promise<string> {
  const base = target.url.replace(/\/+$/, '');
  const f = target.fetchImpl ?? fetch;
  const res = await f(`${base}/remote/boxes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${target.adminToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  if (res.status !== 202) {
    throw new Error(`enqueue failed: ${res.status} ${await safeText(res)}`);
  }
  return ((await res.json()) as { jobId: string }).jobId;
}

/** Fetch one job's current row. */
export async function getHubJob(target: HubTarget, jobId: string): Promise<CreateJobRow | null> {
  const base = target.url.replace(/\/+$/, '');
  const f = target.fetchImpl ?? fetch;
  const res = await f(`${base}/remote/boxes/${encodeURIComponent(jobId)}`, {
    headers: { Authorization: `Bearer ${target.adminToken}` },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`job status failed: ${res.status} ${await safeText(res)}`);
  return (await res.json()) as CreateJobRow;
}

export interface PollOptions {
  intervalMs?: number;
  /** Give up after this long. Default 30 min (a real cloud create can be slow). */
  timeoutMs?: number;
  onStatus?: (job: CreateJobRow) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll a job until it reaches `done`/`failed` (or the timeout). Reports each
 * observed status transition via `onStatus`.
 */
export async function pollHubJob(
  target: HubTarget,
  jobId: string,
  opts: PollOptions = {},
): Promise<CreateJobRow> {
  const intervalMs = opts.intervalMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastStatus = '';
  for (;;) {
    const job = await getHubJob(target, jobId);
    if (!job) throw new Error(`job ${jobId} disappeared from the control plane`);
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      opts.onStatus?.(job);
    }
    if (job.status === 'done' || job.status === 'failed') return job;
    if (now() >= deadline) {
      throw new Error(`timed out waiting for job ${jobId} (last status: ${job.status})`);
    }
    await sleep(intervalMs);
  }
}
