import { readFile, stat } from 'node:fs/promises';
import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import { readState } from '@agentbox/sandbox-core';
import {
  deleteJob,
  loadQueue,
  loadQueueConfig,
  readJob,
  writeJob,
  type QueueJob,
  type QueueJobStatus,
} from '@agentbox/relay';
import { resolveBoxOrExit } from '../box-ref.js';
import { providerForBox } from '../provider/registry.js';
import type { HubApiJob } from '../control-plane/hub-api-client.js';

interface QueueListOpts {
  all?: boolean;
}

const HIDDEN_LIST_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

export const queueCommand = new Command('queue').description(
  'Inspect and manage background `agentbox claude|codex|opencode -i` jobs',
);

const queueListCommand = new Command('list')
  .description('List queued, running, and (with --all) terminal background jobs')
  .option('--all', 'include done/failed/cancelled jobs (default: hide terminal)')
  .action(async (opts: QueueListOpts) => {
    const cfg = await loadQueueConfig();
    const jobs = await listJobsForQueueView();
    const visible =
      opts.all === true ? jobs : jobs.filter((j) => !HIDDEN_LIST_STATUSES.has(j.status));
    if (visible.length === 0) {
      log.info(opts.all ? 'no jobs.' : 'no active jobs (--all to see terminal).');
    } else {
      renderJobTable(visible);
    }
    log.info(
      `queue.maxConcurrent = ${String(cfg.maxConcurrent)} (queue.enabled=${String(cfg.enabled)})`,
    );
  });

/**
 * The unified job view for `queue list`. Prefers the hub's `/api/v1/jobs`
 * (`preferLocal` — this laptop's own `-i` queue; a control box's create queue is
 * `agentbox hub jobs`). Degrades to the LOCAL `~/.agentbox/queue/` manifests when
 * the hub is stopped/unreachable, so `queue list` still works offline (the
 * pre-hub behavior). For a co-located local hub the two are the same manifests.
 */
async function listJobsForQueueView(): Promise<HubApiJob[]> {
  try {
    // Quiet + no autostart: a read-only `list` must not spin up a daemon. If the
    // hub is already running we get the API view; otherwise fall back to disk.
    // Lazy import keeps the hub.ts <-> control-plane.ts cycle intact (Step 0).
    const { resolveHubApiClient } = await import('../commands/control-plane.js');
    const client = await resolveHubApiClient(undefined, { quiet: true, preferLocal: true });
    if (client) return await client.listJobs();
  } catch {
    /* hub unreachable — fall through to the local manifests */
  }
  const local = await loadQueue();
  return local
    .filter((j) => j.kind !== 'prepare')
    .map((j) => ({
      id: j.id,
      status: j.status,
      boxId: j.boxId,
      error: j.status === 'failed' ? j.reason : undefined,
      provider: j.providerName,
      name: j.boxName || undefined,
      agent: j.noAgent ? 'none' : j.agent,
      createdAt: j.createdAt,
    }));
}

/** A compact ASCII table over the unified job listing; id is the cancel/show handle. */
function renderJobTable(jobs: HubApiJob[]): void {
  const rows = jobs.map((j) => ({
    // Print the FULL id — `queue show`/`cancel` resolve it against the local
    // manifest by exact id (no prefix match), so a truncated id wouldn't resolve.
    id: j.id,
    status: j.status,
    agent: j.agent ?? '-',
    box: j.name || j.boxId || '(auto)',
    provider: j.provider ?? '-',
    age: j.createdAt ? formatAge(j.createdAt) : '?',
  }));
  const headers = ['id', 'status', 'agent', 'box', 'provider', 'age'] as const;
  const widths = headers.map((h) =>
    Math.max(h.length, ...rows.map((r) => String(r[h as keyof typeof r]).length)),
  );
  const pad = (s: string, w: number): string => s + ' '.repeat(Math.max(0, w - s.length));
  process.stdout.write(headers.map((h, i) => pad(h, widths[i]!)).join('  ') + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const r of rows) {
    process.stdout.write(
      headers.map((h, i) => pad(String(r[h as keyof typeof r]), widths[i]!)).join('  ') + '\n',
    );
  }
}

const queueShowCommand = new Command('show')
  .description('Dump a job manifest and tail its log')
  .argument('<id>', 'queue job id (from `agentbox queue list`)')
  .option('--tail <n>', 'lines of log to print (default: 50)', '50')
  .action(async (id: string, opts: { tail: string }) => {
    const job = await readJob(id);
    if (!job) {
      log.error(`no job with id ${id}`);
      process.exit(1);
    }
    process.stdout.write(JSON.stringify(job, null, 2) + '\n');
    const tailN = Number.parseInt(opts.tail, 10) || 50;
    try {
      await stat(job.logPath);
      const text = await readFile(job.logPath, 'utf8');
      const lines = text.split(/\r?\n/);
      const slice = lines.slice(Math.max(0, lines.length - tailN - 1));
      process.stdout.write(`\n--- last ${String(tailN)} lines of ${job.logPath} ---\n`);
      process.stdout.write(slice.join('\n'));
      if (!slice.join('\n').endsWith('\n')) process.stdout.write('\n');
    } catch {
      log.info(`(no log at ${job.logPath} yet)`);
    }
  });

const queueCancelCommand = new Command('cancel')
  .description('Cancel a queued job; running jobs are NOT killed — use `agentbox destroy` instead')
  .argument('<id>', 'queue job id (from `agentbox queue list`)')
  .action(async (id: string) => {
    intro(`Cancelling queue job ${id}...`);
    const job = await readJob(id);
    if (!job) {
      log.error(`no job with id ${id}`);
      process.exit(1);
    }
    if (job.status !== 'queued') {
      log.error(
        `job ${id} is ${job.status}; cancel only flips 'queued' → 'cancelled'.` +
          (job.status === 'running'
            ? ` Use 'agentbox destroy ${job.boxName || id}' to stop the box.`
            : ''),
      );
      process.exit(1);
    }
    const cancelled: QueueJob = {
      ...job,
      status: 'cancelled',
      finishedAt: new Date().toISOString(),
      reason: 'cancelled by user',
    };
    await writeJob(cancelled);
    outro(`job ${id} cancelled`);
  });

const queueClearCommand = new Command('clear')
  .description('Sweep terminal-state manifests from ~/.agentbox/queue/')
  .option('--done', 'remove done jobs')
  .option('--failed', 'remove failed jobs')
  .option('--cancelled', 'remove cancelled jobs')
  .option('--all', 'remove every terminal-state job (done + failed + cancelled)')
  .action(
    async (opts: { done?: boolean; failed?: boolean; cancelled?: boolean; all?: boolean }) => {
      const targets = new Set<QueueJobStatus>();
      if (opts.all === true || opts.done === true) targets.add('done');
      if (opts.all === true || opts.failed === true) targets.add('failed');
      if (opts.all === true || opts.cancelled === true) targets.add('cancelled');
      if (targets.size === 0) {
        log.error('pick at least one of: --done, --failed, --cancelled, --all');
        process.exit(2);
      }
      const jobs = await loadQueue();
      let removed = 0;
      for (const j of jobs) {
        if (!targets.has(j.status)) continue;
        await deleteJob(j.id);
        removed += 1;
      }
      log.success(`removed ${String(removed)} manifest${removed === 1 ? '' : 's'}`);
    },
  );

const QUEUE_WAIT_EVENTS = [
  'new-box',
  'empty-queue',
  'box-paused',
  'box-running',
  'box-stopped',
  'job-done',
] as const;
type QueueWaitEvent = (typeof QUEUE_WAIT_EVENTS)[number];

const ACTIVE_JOB_STATUSES: ReadonlySet<QueueJobStatus> = new Set(['queued', 'running']);
const DEFAULT_QUEUE_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const QUEUE_POLL_INTERVAL_MS = 500;

interface QueueWaitOpts {
  box?: string;
  job?: string;
  timeout?: string;
  json?: boolean;
}

const queueWaitForCommand = new Command('wait-for')
  .description(
    `Block until a queue / box event fires. <event> one of: ${QUEUE_WAIT_EVENTS.join(' | ')}.`,
  )
  .argument('<event>', `target event: ${QUEUE_WAIT_EVENTS.join(' | ')}`)
  .option('--box <ref>', 'box ref (required for box-paused / box-running / box-stopped)')
  .option('--job <id>', 'queue job id (required for job-done)')
  .option('--timeout <ms>', `wall-clock cap (default: ${String(DEFAULT_QUEUE_WAIT_TIMEOUT_MS)})`)
  .option('--json', 'emit a JSON envelope { matched, elapsedMs, ... }')
  .action(async (eventRaw: string, opts: QueueWaitOpts) => {
    if (!QUEUE_WAIT_EVENTS.includes(eventRaw as QueueWaitEvent)) {
      log.error(`unknown event '${eventRaw}' (one of: ${QUEUE_WAIT_EVENTS.join(', ')})`);
      process.exit(2);
    }
    const event = eventRaw as QueueWaitEvent;
    const timeoutMs =
      opts.timeout !== undefined
        ? parsePositiveInt(opts.timeout, '--timeout')
        : DEFAULT_QUEUE_WAIT_TIMEOUT_MS;
    const start = Date.now();
    const deadline = start + timeoutMs;

    try {
      const match = await waitForQueueEvent(event, opts, deadline);
      const elapsedMs = Date.now() - start;
      if (opts.json === true) {
        process.stdout.write(JSON.stringify({ matched: true, event, elapsedMs, ...match }) + '\n');
      }
      return;
    } catch (err) {
      if (err instanceof QueueWaitTimeout) {
        const elapsedMs = Date.now() - start;
        if (opts.json === true) {
          process.stdout.write(JSON.stringify({ matched: false, event, elapsedMs }) + '\n');
        } else {
          log.error(`'${event}' did not occur within ${String(timeoutMs)}ms`);
        }
        process.exit(1);
      }
      log.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  });

class QueueWaitTimeout extends Error {
  constructor() {
    super('queue wait-for timeout');
    this.name = 'QueueWaitTimeout';
  }
}

async function waitForQueueEvent(
  event: QueueWaitEvent,
  opts: QueueWaitOpts,
  deadline: number,
): Promise<Record<string, unknown>> {
  if (event === 'empty-queue') {
    return pollUntil(deadline, async () => {
      const jobs = await loadQueue();
      const active = jobs.filter((j) => ACTIVE_JOB_STATUSES.has(j.status));
      return active.length === 0 ? { activeCount: 0 } : undefined;
    });
  }

  if (event === 'new-box') {
    const initial = new Set((await readState()).boxes.map((b) => b.id));
    return pollUntil(deadline, async () => {
      const current = await readState();
      const fresh = current.boxes.find((b) => !initial.has(b.id));
      return fresh ? { boxId: fresh.id, boxName: fresh.name } : undefined;
    });
  }

  if (event === 'job-done') {
    if (!opts.job) {
      throw new Error('queue wait-for job-done requires --job <id>');
    }
    const jobId = opts.job;
    return pollUntil(deadline, async () => {
      const job = await readJob(jobId);
      if (!job) throw new Error(`no job with id ${jobId}`);
      const terminal: ReadonlySet<QueueJobStatus> = new Set(['done', 'failed', 'cancelled']);
      return terminal.has(job.status)
        ? { jobId: job.id, status: job.status, exitCode: job.exitCode ?? null }
        : undefined;
    });
  }

  // box-paused | box-running | box-stopped
  if (!opts.box) {
    throw new Error(`queue wait-for ${event} requires --box <ref>`);
  }
  const box = await resolveBoxOrExit(opts.box);
  const provider = await providerForBox(box);
  const targetMap: Record<'box-paused' | 'box-running' | 'box-stopped', readonly string[]> = {
    'box-paused': ['paused'],
    'box-running': ['running'],
    'box-stopped': ['stopped', 'missing'],
  };
  const targets = new Set(targetMap[event]);
  return pollUntil(deadline, async () => {
    const state = await provider.probeState(box);
    return targets.has(state) ? { boxId: box.id, state } : undefined;
  });
}

async function pollUntil<T>(deadline: number, probe: () => Promise<T | undefined>): Promise<T> {
  while (Date.now() < deadline) {
    const result = await probe();
    if (result !== undefined) return result;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(QUEUE_POLL_INTERVAL_MS, remaining));
  }
  throw new QueueWaitTimeout();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function parsePositiveInt(raw: string, label: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== raw.trim()) {
    throw new Error(`${label} must be a positive integer (got: ${raw})`);
  }
  return n;
}

queueCommand.addCommand(queueListCommand);
queueCommand.addCommand(queueShowCommand);
queueCommand.addCommand(queueCancelCommand);
queueCommand.addCommand(queueClearCommand);
queueCommand.addCommand(queueWaitForCommand);

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '?';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.floor(h / 24);
  return `${String(d)}d`;
}
