import { FatalPollError, ab, abJson, poll, type RunResult } from './exec.js';
import { hubBox, type HubBox } from './hub.js';
import type { Ctx } from './runner.js';

/** Run a shell command inside a box as the box user, from /workspace. */
export function boxSh(
  ctx: Ctx,
  box: string,
  script: string,
  opts: { allowFail?: boolean; timeoutMs?: number } = {},
): Promise<RunResult> {
  return ab(['shell', box, '--', 'bash', '-lc', `cd /workspace && ${script}`], {
    log: ctx.log,
    allowFail: opts.allowFail,
    timeoutMs: opts.timeoutMs ?? 180_000,
  });
}

export interface QueueJobDone {
  matched: boolean;
  status?: string;
  exitCode?: number;
  jobId?: string;
}

/**
 * `agentbox <agent> -i "<prompt>"`: queue a background create + first agent turn, then
 * wait for the host queue to report the create job done. Returns the job id.
 */
export async function queueAgentBox(
  ctx: Ctx,
  opts: {
    agent: string;
    name: string;
    prompt: string;
    cwd: string;
    extra?: string[];
    /** Passed to the agent itself, after `--`. */
    agentArgs?: string[];
    timeoutMs?: number;
  },
): Promise<string> {
  ctx.trackBox(opts.name);
  const r = await ab(
    [
      opts.agent,
      '--provider',
      ctx.target.providerArg,
      '-y',
      '-n',
      opts.name,
      '--carry-yes',
      ...(opts.extra ?? []),
      '-i',
      opts.prompt,
      ...(opts.agentArgs?.length ? ['--', ...opts.agentArgs] : []),
    ],
    { cwd: opts.cwd, log: ctx.log, timeoutMs: 180_000 },
  );
  const m = /job (\S+) queued/.exec(r.stdout + r.stderr);
  if (!m?.[1]) throw new Error(`no "job <id> queued" in output:\n${r.stdout}${r.stderr}`);
  const jobId = m[1];
  const done = await abJson<QueueJobDone>(
    [
      'queue',
      'wait-for',
      'job-done',
      '--job',
      jobId,
      '--timeout',
      String(opts.timeoutMs ?? 30 * 60_000),
      '--json',
    ],
    {
      cwd: opts.cwd,
      log: ctx.log,
      timeoutMs: (opts.timeoutMs ?? 30 * 60_000) + 60_000,
      allowFail: true,
    },
  );
  if (!done.matched || done.status !== 'done' || (done.exitCode ?? 0) !== 0) {
    throw new Error(
      `create job ${jobId} ended ${JSON.stringify(done)}; see ~/.agentbox/logs/queue-${jobId}.log`,
    );
  }
  return jobId;
}

/** Plain `agentbox create` (no agent session). */
export async function createBox(
  ctx: Ctx,
  name: string,
  cwd: string,
  extra: string[] = [],
): Promise<void> {
  ctx.trackBox(name);
  await ab(
    ['create', '--provider', ctx.target.providerArg, '-y', '-n', name, '--carry', 'skip', ...extra],
    {
      cwd,
      log: ctx.log,
      timeoutMs: 30 * 60_000,
    },
  );
}

/**
 * The agent turn is done when its commit is in the box. The agent-state probe
 * (`agent wait-for input-needed`) can report `idle` before the turn starts and
 * `working` after it ends, so the git result is the ground truth.
 */
export async function waitForBoxCommit(
  ctx: Ctx,
  box: string,
  subject: string,
  timeoutMs = 10 * 60_000,
): Promise<void> {
  await poll(
    `commit "${subject}" in ${box}`,
    async () => {
      const r = await boxSh(ctx, box, 'git log --format=%s -20', {
        allowFail: true,
        timeoutMs: 60_000,
      });
      if (r.exitCode === 0 && r.stdout.split('\n').some((l) => l.trim() === subject)) return true;
      // Fail fast when the agent is gone rather than waiting out the whole timeout.
      const st = await abJson<{ sessionRunning?: boolean; state?: string }>(
        ['agent', 'state', box, '--json'],
        {
          log: ctx.log,
          allowFail: true,
        },
      ).catch(() => undefined);
      if (st && (st.sessionRunning === false || st.state === 'error')) {
        throw new FatalPollError(
          `the agent session in ${box} exited before committing (state ${String(st.state)})`,
        );
      }
      return false;
    },
    { timeoutMs, intervalMs: 10_000 },
  );
}

export async function boxState(name: string): Promise<string | undefined> {
  const b = await hubBox(name);
  return b ? (b.state ?? b.status) : undefined;
}

export async function waitBoxState(
  ctx: Ctx,
  name: string,
  want: string[],
  timeoutMs = 10 * 60_000,
): Promise<HubBox> {
  return poll(
    `${name} state in [${want.join(',')}]`,
    async () => {
      const b = await hubBox(name);
      const s = b ? (b.state ?? b.status) : undefined;
      return b && s && want.includes(s) ? b : undefined;
    },
    { timeoutMs, intervalMs: 5000 },
  );
}

export async function destroyBoxes(ctx: Ctx, names: Iterable<string>): Promise<void> {
  for (const name of names) {
    if (!(await hubBox(name))) continue;
    await ab(['destroy', '-y', '--force', name], {
      log: ctx.log,
      allowFail: true,
      timeoutMs: 15 * 60_000,
    });
  }
}
