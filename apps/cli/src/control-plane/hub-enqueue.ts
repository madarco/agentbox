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

export type HubJobLogResult =
  /** Lines (possibly none) read from the job's log. */
  | { kind: 'ok'; tail: JobLogTail }
  /**
   * This control box has no log route: an older hub, or the serverless plane,
   * where the worker's per-step lines don't exist as a file. Permanent —
   * callers stop asking and fall back to status-only progress. (A genuinely
   * missing job already surfaces from the status poll, so a 404 here is silent.)
   */
  | { kind: 'unsupported' }
  /**
   * A blip: connection reset, a proxy's 502/503, a body that isn't the shape we
   * expect. NOT a reason to stop tailing — a hub create is minutes long, and one
   * bad tick used to drop the rest of the run back to a static status line.
   */
  | { kind: 'unavailable' };

/** Read a job's progress log from `offset` (bytes). Never throws. */
export async function fetchHubJobLog(
  target: HubTarget,
  jobId: string,
  offset: number,
): Promise<HubJobLogResult> {
  const base = target.url.replace(/\/+$/, '');
  const f = target.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await f(
      `${base}/remote/boxes/${encodeURIComponent(jobId)}/logs?offset=${String(offset)}`,
      { headers: { Authorization: `Bearer ${target.adminToken}` } },
    );
  } catch {
    return { kind: 'unavailable' };
  }
  // 404 (an old hub routes `<id>/logs` into its by-id lookup), 405, 501 (a plane
  // with no reader wired) all mean "this hub will never serve logs".
  if (res.status === 404 || res.status === 405 || res.status === 501) {
    return { kind: 'unsupported' };
  }
  if (!res.ok) return { kind: 'unavailable' };
  const body = (await res.json().catch(() => null)) as JobLogTail | null;
  if (!body || !Array.isArray(body.lines) || typeof body.offset !== 'number') {
    return { kind: 'unavailable' };
  }
  return { kind: 'ok', tail: body };
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
    const res = await fetchHubJobLog(target, jobId, offset).catch(
      () => ({ kind: 'unavailable' }) as const,
    );
    // Only a hub that CAN'T serve logs ends the tail; a transient failure just
    // skips this tick and retries from the same offset.
    if (res.kind === 'unsupported') {
      tailing = false;
      return;
    }
    if (res.kind !== 'ok') return;
    offset = res.tail.offset;
    for (const line of res.tail.lines) opts.onLog?.(line);
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
