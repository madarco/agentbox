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

/**
 * Recent jobs on the control box's create queue, newest first.
 *
 * This is a different queue from the PC's local `~/.agentbox/queue/`: with a
 * control box configured, background `-i` cloud runs are enqueued HERE, so the
 * local queue alone is an incomplete picture of what's running.
 */
export async function listHubJobs(target: HubTarget): Promise<CreateJobRow[]> {
  const base = target.url.replace(/\/+$/, '');
  const f = target.fetchImpl ?? fetch;
  const res = await f(`${base}/remote/boxes`, {
    headers: { Authorization: `Bearer ${target.adminToken}` },
  });
  if (!res.ok) throw new Error(`list jobs failed: ${res.status} ${await safeText(res)}`);
  // Tolerate a 200 that isn't the shape we expect (a proxy's interstitial, a
  // hub mid-upgrade): render an empty queue rather than iterating `undefined`.
  const body = (await res.json()) as { jobs?: unknown };
  return Array.isArray(body.jobs) ? (body.jobs as CreateJobRow[]) : [];
}

export interface JobLogTail {
  lines: string[];
  offset: number;
}

/**
 * Read a job's progress log from `offset` (bytes). `null` means this control box
 * has no log route — an older hub, or the serverless plane, where the worker's
 * per-step lines don't exist as a file. Callers stop tailing and fall back to
 * status-only progress; a genuinely missing job already surfaces from the status
 * poll, so this stays silent.
 */
export async function fetchHubJobLog(
  target: HubTarget,
  jobId: string,
  offset: number,
): Promise<JobLogTail | null> {
  const base = target.url.replace(/\/+$/, '');
  const f = target.fetchImpl ?? fetch;
  const res = await f(
    `${base}/remote/boxes/${encodeURIComponent(jobId)}/logs?offset=${String(offset)}`,
    { headers: { Authorization: `Bearer ${target.adminToken}` } },
  );
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as JobLogTail | null;
  if (!body || !Array.isArray(body.lines) || typeof body.offset !== 'number') return null;
  return body;
}

export interface PollOptions {
  intervalMs?: number;
  /** Give up after this long. Default 30 min (a real cloud create can be slow). */
  timeoutMs?: number;
  onStatus?: (job: CreateJobRow) => void;
  /**
   * The worker's own progress lines, drained from the job's log between status
   * checks. Set it and the wait shows what the remote hub is actually doing
   * (clone, seed, the provider's create output) instead of a static `running`.
   */
  onLog?: (line: string) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Poll a job until it reaches `done`/`failed` (or the timeout). Reports each
 * observed status transition via `onStatus`, and (when `onLog` is set) every
 * line the hub worker appended to the job's log since the last tick.
 */
export async function pollHubJob(
  target: HubTarget,
  jobId: string,
  opts: PollOptions = {},
): Promise<CreateJobRow> {
  // The log tail makes a tick worth taking more often: a status-only poll can
  // only ever report two transitions, a log poll usually has something to show.
  const intervalMs = opts.intervalMs ?? (opts.onLog ? 2000 : 3000);
  const timeoutMs = opts.timeoutMs ?? 30 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + timeoutMs;
  let lastStatus = '';
  let offset = 0;
  let tailing = opts.onLog !== undefined;

  const drainLog = async (): Promise<void> => {
    if (!tailing) return;
    // Never fail a create because its progress log couldn't be read.
    const tail = await fetchHubJobLog(target, jobId, offset).catch(() => null);
    if (!tail) {
      tailing = false;
      return;
    }
    offset = tail.offset;
    for (const line of tail.lines) opts.onLog?.(line);
  };

  for (;;) {
    const job = await getHubJob(target, jobId);
    if (!job) throw new Error(`job ${jobId} disappeared from the control plane`);
    if (job.status !== lastStatus) {
      lastStatus = job.status;
      opts.onStatus?.(job);
    }
    await drainLog();
    // The worker writes its last lines (the failure, the box id) around the same
    // moment it flips the status, so drain once more after the terminal read.
    if (job.status === 'done' || job.status === 'failed') {
      await drainLog();
      return job;
    }
    if (now() >= deadline) {
      throw new Error(`timed out waiting for job ${jobId} (last status: ${job.status})`);
    }
    await sleep(intervalMs);
  }
}
