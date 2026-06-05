import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import {
  defaultCountRunningBoxes,
  loadQueueConfig,
  queueLogPath,
  writeJob,
  type QueueAgentKind,
  type QueueJob,
  type QueueJobCreateOpts,
  type QueueJobOpenTerminal,
} from '@agentbox/relay';
import { DEFAULT_RELAY_PORT, ensureRelay } from '@agentbox/sandbox-docker';

export interface SubmitQueueJobInput {
  agent: QueueAgentKind;
  boxName: string;
  providerName: string;
  prompt: string;
  agentArgs: string[];
  createOpts: QueueJobCreateOpts;
  /** Per-invocation override of queue.maxConcurrent. */
  maxRunningOverride?: number;
  /** Per-invocation override of queue.maxWorking. */
  maxWorkingOverride?: number;
  /**
   * Host-terminal targeting captured at submit time (when `queue.openIn` is not
   * `none`). Carried on the job so the worker opens a fresh terminal onto the
   * box once it is ready. Absent → open nothing.
   */
  openTerminal?: QueueJobOpenTerminal;
}

export interface SubmitQueueJobResult {
  job: QueueJob;
  /** Cross-provider running count at the time of submit (informational only). */
  runningCount: number;
  /** Effective ceiling used for the job (override or global). */
  maxConcurrent: number;
  /** Whether the manifest was visible to the relay's scheduler immediately. */
  pokedRelay: boolean;
}

/**
 * Write a queued job manifest, ensure the host relay is running, and notify
 * it via `POST /admin/queue/enqueue` so the scheduler picks up the new entry
 * without waiting for the next periodic tick. Best-effort on the HTTP call:
 * if the relay is unreachable the manifest still lives on disk and the next
 * tick (after the relay starts) will see it.
 */
export async function submitQueueJob(
  input: SubmitQueueJobInput,
): Promise<SubmitQueueJobResult> {
  const cfg = await loadQueueConfig();
  const ceiling =
    typeof input.maxRunningOverride === 'number' && input.maxRunningOverride > 0
      ? input.maxRunningOverride
      : cfg.maxConcurrent;

  const maxWorking =
    typeof input.maxWorkingOverride === 'number' && input.maxWorkingOverride > 0
      ? input.maxWorkingOverride
      : undefined;

  const id = newJobId();
  const job: QueueJob = {
    id,
    agent: input.agent,
    status: 'queued',
    boxName: input.boxName,
    providerName: input.providerName,
    prompt: input.prompt,
    agentArgs: input.agentArgs,
    createOpts: input.createOpts,
    maxConcurrent: ceiling,
    ...(maxWorking !== undefined ? { maxWorking } : {}),
    ...(input.openTerminal !== undefined ? { openTerminal: input.openTerminal } : {}),
    createdAt: new Date().toISOString(),
    logPath: queueLogPath(id),
  };
  await writeJob(job);

  let runningCount = 0;
  try {
    runningCount = await defaultCountRunningBoxes();
  } catch {
    runningCount = 0;
  }

  let pokedRelay = false;
  try {
    await ensureRelay();
    await postEnqueue(id);
    pokedRelay = true;
  } catch {
    // Manifest is on disk; next relay tick (after a future `ensureRelay`)
    // picks it up. Suppress the noise on a relay-down case — the CLI's
    // outer command already prints a `log: <path>` for the per-job log.
  }

  return { job, runningCount, maxConcurrent: ceiling, pokedRelay };
}

function newJobId(): string {
  // 9-byte URL-safe id (18 hex). Short enough to type, wide enough to never
  // collide in practice. Mirrors the existing per-box mnemonic id length.
  return randomBytes(9).toString('hex');
}

function postEnqueue(id: string): Promise<void> {
  const json = JSON.stringify({ id });
  return new Promise<void>((resolveP, rejectP) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: DEFAULT_RELAY_PORT,
        method: 'POST',
        path: '/admin/queue/enqueue',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json).toString(),
        },
        timeout: 2_000,
      },
      (res) => {
        res.resume();
        const status = res.statusCode ?? 0;
        if (status >= 200 && status < 300) resolveP();
        else rejectP(new Error(`enqueue → ${String(status)}`));
      },
    );
    req.on('error', rejectP);
    req.on('timeout', () => {
      req.destroy();
      rejectP(new Error('enqueue timeout'));
    });
    req.write(json);
    req.end();
  });
}
