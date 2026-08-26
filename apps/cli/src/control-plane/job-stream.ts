/**
 * Drive a hub create/agent job to completion from the CLI — the one streaming
 * path `create` and the via-hub agent helpers share (`docs/hub-api-single-path-plan.md`
 * Step 8).
 *
 * Three guarantees, all load-bearing:
 *   - **Progress streams.** The worker's per-step lines are streamed live over
 *     `GET /api/v1/jobs/:id/logs`, so a detached create never looks hung.
 *   - **The verdict comes from polling, not the stream.** A dropped SSE must not
 *     read as success — the terminal status is always read from `GET /jobs/:id`
 *     (mirrors `bakeViaHub`). A job that vanished is a failure, not a "done".
 *   - **The login-code affordance survives.** When the job parks awaiting a Claude
 *     re-login, we surface the URL and (on a TTY) prompt for the pasted code and
 *     POST it back — the one interactive create affordance the plan keeps.
 */
import { isCancel, log, text } from '@clack/prompts';
import { HubApiError, type HubApiClient, type HubApiJob } from './hub-api-client.js';

/** How often the job's terminal status is re-checked while the log streams. */
const JOB_POLL_MS = 2000;
/**
 * Cap on a single create. Generous: a cold cloud create is genuinely minutes;
 * a job that outlives this is still running on the hub, so the caller is told
 * where to watch it rather than left on a hung terminal.
 */
const CREATE_TIMEOUT_MS = 45 * 60_000;

export type JobStreamStatus = 'done' | 'failed' | 'gone' | 'timeout';

export interface JobStreamResult {
  /** Terminal status. Only `done` is success. */
  status: JobStreamStatus;
  /** The last job row observed (carries boxId, error, ...). Absent if it vanished. */
  job?: HubApiJob;
  /** A human-readable failure detail for non-`done` outcomes. */
  detail?: string;
}

export interface JobStreamOptions {
  /** Worker log lines (already newline-free). */
  onLine: (line: string) => void;
  /** Status transitions (queued → running → done/failed). */
  onStatus?: (status: string) => void;
  /**
   * Prompt for the Claude re-login OAuth code. Provided by the caller so it can
   * pause its own spinner. Returns the pasted code, or null to skip. Omit to fall
   * back to the built-in TTY prompt (or, non-TTY, surfacing the URL once).
   */
  onLoginPrompt?: (url: string, lastError?: string) => Promise<string | null>;
  timeoutMs?: number;
  /** Poll interval override (tests). Defaults to {@link JOB_POLL_MS}. */
  pollMs?: number;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Built-in login prompt: print the approval URL and (on a TTY) read the pasted
 * code. Non-TTY surfaces the URL + how to answer and returns null (the caller's
 * job will time out awaiting the code, which is the honest outcome — there is no
 * one to paste it).
 */
async function defaultLoginPrompt(url: string, lastError?: string): Promise<string | null> {
  if (lastError) log.warn(`login code rejected: ${lastError}`);
  log.warn(`Claude re-login required — open:\n  ${url}`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.info(
      'paste the approval code from a terminal with `agentbox hub jobs` on this machine, or re-run interactively.',
    );
    return null;
  }
  const answer = await text({ message: 'paste the approval code' });
  if (isCancel(answer) || typeof answer !== 'string' || answer.trim().length === 0) return null;
  return answer.trim();
}

/**
 * Stream a job to a terminal state. The log stream is advisory; the returned
 * status is always from the polled job (or `gone`/`timeout`). The caller decides
 * how to report — a `done` with a boxId is success; everything else is a failure.
 */
export async function streamJobToCompletion(
  client: HubApiClient,
  jobId: string,
  opts: JobStreamOptions,
): Promise<JobStreamResult> {
  const abort = new AbortController();
  // Fire-and-forget: the stream ends when the hub closes it. Losing the log must
  // not lose the create, so errors are swallowed — the poll is the source of truth.
  const streaming = client.streamJobLog(jobId, opts.onLine, abort.signal).catch(() => undefined);

  const prompt = opts.onLoginPrompt ?? defaultLoginPrompt;
  const pollMs = opts.pollMs ?? JOB_POLL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? CREATE_TIMEOUT_MS);
  let lastStatus = '';
  let lastJob: HubApiJob | undefined;
  // Login-code de-dup: prompt once per (url, lastError) pair so a rejected code
  // re-prompts but a steady `awaiting-code` doesn't spam.
  let loginKey = '';
  let loginInFlight = false;

  try {
    for (;;) {
      const job = await client.getJob(jobId).catch((err) => {
        // A transient poll error is not terminal — keep tailing. A real
        // not_found (the job vanished) surfaces as null below via a rethrow guard.
        if (err instanceof HubApiError && err.code === 'not_found') return null;
        return undefined;
      });
      if (job === null) {
        return { status: 'gone', detail: `create job ${jobId} disappeared from the hub` };
      }
      if (job) {
        lastJob = job;
        if (job.status !== lastStatus) {
          lastStatus = job.status;
          opts.onStatus?.(job.status);
        }
        if (job.status === 'done') return { status: 'done', job };
        if (job.status === 'failed' || job.status === 'cancelled') {
          return { status: 'failed', job, detail: job.error };
        }
        // Login-code affordance: park until the user answers (or the job times out).
        const login = job.login;
        if (login?.phase === 'awaiting-code' && login.url && !loginInFlight) {
          const key = `${login.url}\n${login.lastError ?? ''}`;
          if (key !== loginKey) {
            loginKey = key;
            loginInFlight = true;
            try {
              const code = await prompt(login.url, login.lastError);
              if (code) await client.submitLoginCode(jobId, code).catch(() => {});
            } finally {
              loginInFlight = false;
            }
          }
        }
      }
      if (Date.now() > deadline) {
        return {
          status: 'timeout',
          job: lastJob,
          detail: `the create is still running on the hub after ${String(Math.round((opts.timeoutMs ?? CREATE_TIMEOUT_MS) / 60_000))} minutes — watch job ${jobId} with \`agentbox hub jobs\``,
        };
      }
      await delay(pollMs);
    }
  } finally {
    abort.abort();
    await streaming;
  }
}
