import { readFile, stat } from 'node:fs/promises';
import { intro, log, outro } from '@clack/prompts';
import { Command } from 'commander';
import {
  deleteJob,
  loadQueue,
  loadQueueConfig,
  readJob,
  writeJob,
  type QueueJob,
  type QueueJobStatus,
} from '@agentbox/relay';

interface QueueListOpts {
  all?: boolean;
}

const TERMINAL_STATUSES: ReadonlySet<QueueJobStatus> = new Set(['done', 'failed', 'cancelled']);

export const queueCommand = new Command('queue')
  .description('Inspect and manage background `agentbox claude|codex|opencode -i` jobs');

const queueListCommand = new Command('list')
  .description('List queued, running, and (with --all) terminal background jobs')
  .option('--all', 'include done/failed/cancelled jobs (default: hide terminal)')
  .action(async (opts: QueueListOpts) => {
    const jobs = await loadQueue();
    const cfg = await loadQueueConfig();
    const visible = opts.all === true ? jobs : jobs.filter((j) => !TERMINAL_STATUSES.has(j.status));
    if (visible.length === 0) {
      log.info(opts.all ? 'no queued jobs.' : 'no active queued jobs (--all to see terminal).');
      log.info(`queue.maxConcurrent = ${String(cfg.maxConcurrent)} (queue.enabled=${String(cfg.enabled)})`);
      return;
    }
    // Build a compact ASCII table; one row per job. Keep columns predictable so
    // it greps cleanly (id is the unique handle for cancel/show).
    const rows = visible.map((j) => ({
      id: j.id,
      status: j.status,
      agent: j.agent,
      box: j.boxName || '(auto)',
      provider: j.providerName,
      max: String(j.maxConcurrent),
      age: formatAge(j.createdAt),
      prompt: truncate(j.prompt, 48),
    }));
    const headers = ['id', 'status', 'agent', 'box', 'provider', 'max', 'age', 'prompt'] as const;
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
    log.info(`queue.maxConcurrent = ${String(cfg.maxConcurrent)} (queue.enabled=${String(cfg.enabled)})`);
  });

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
          (job.status === 'running' ? ` Use 'agentbox destroy ${job.boxName || id}' to stop the box.` : ''),
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
  .action(async (opts: { done?: boolean; failed?: boolean; cancelled?: boolean; all?: boolean }) => {
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
  });

queueCommand.addCommand(queueListCommand);
queueCommand.addCommand(queueShowCommand);
queueCommand.addCommand(queueCancelCommand);
queueCommand.addCommand(queueClearCommand);

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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
