import { BoxRegistry, EventBuffer } from '../registry.js';
import { BoxStatusStore } from '../status-store.js';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import type { CreateJobRow, PromptRow, Store } from './store.js';

export interface MemoryStoreParts {
  registry?: BoxRegistry;
  events?: EventBuffer;
  statusStore?: BoxStatusStore;
}

/**
 * In-memory {@link Store} — the laptop loopback relay default and the test
 * default. It wraps the original `BoxRegistry` / `EventBuffer` /
 * `BoxStatusStore` instances verbatim, so it is behaviorally identical to the
 * pre-seam relay (status still persists to `~/.agentbox/boxes/<id>/status.json`
 * via `BoxStatusStore.set`). The wrapped instances are exposed so the relay
 * handle can keep handing them to the autopause / queue loops and the unit
 * tests, which read them synchronously.
 */
export class MemoryStore implements Store {
  readonly registry: BoxRegistry;
  readonly events: EventBuffer;
  readonly statusStore: BoxStatusStore;
  private readonly prompts = new Map<string, PromptRow>();
  private readonly createJobs = new Map<string, CreateJobRow>();

  constructor(parts: MemoryStoreParts = {}) {
    this.registry = parts.registry ?? new BoxRegistry();
    this.events = parts.events ?? new EventBuffer();
    this.statusStore = parts.statusStore ?? new BoxStatusStore();
  }

  registerBox(reg: BoxRegistration): Promise<void> {
    this.registry.register(reg);
    return Promise.resolve();
  }

  getBox(boxId: string): Promise<BoxRegistration | undefined> {
    return Promise.resolve(this.registry.get(boxId));
  }

  authenticateBox(token: string): Promise<BoxRegistration | null> {
    return Promise.resolve(this.registry.authenticate(token));
  }

  listBoxes(): Promise<BoxRegistration[]> {
    return Promise.resolve(this.registry.list());
  }

  forgetBox(boxId: string): Promise<boolean> {
    return Promise.resolve(this.registry.forget(boxId));
  }

  countBoxes(): Promise<number> {
    return Promise.resolve(this.registry.size());
  }

  appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    return Promise.resolve(this.events.append(input));
  }

  listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    return Promise.resolve(this.events.since(since, boxId));
  }

  countEvents(): Promise<number> {
    return Promise.resolve(this.events.size());
  }

  setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    return this.statusStore.set(boxId, name, projectIndex, status);
  }

  getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    return Promise.resolve(this.statusStore.get(boxId));
  }

  deleteStatus(boxId: string): Promise<void> {
    this.statusStore.delete(boxId);
    return Promise.resolve();
  }

  createPrompt(row: PromptRow): Promise<void> {
    this.prompts.set(row.id, { ...row });
    return Promise.resolve();
  }

  getPrompt(promptId: string): Promise<PromptRow | null> {
    const row = this.prompts.get(promptId);
    return Promise.resolve(row ? { ...row } : null);
  }

  answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    const row = this.prompts.get(promptId);
    if (!row || row.status !== 'pending') return Promise.resolve(false);
    row.status = 'answered';
    row.answer = answer;
    row.cancelled = cancelled;
    return Promise.resolve(true);
  }

  listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    const out: PromptRow[] = [];
    for (const row of this.prompts.values()) {
      if (row.boxId === boxId && row.status === 'pending') out.push({ ...row });
    }
    return Promise.resolve(out);
  }

  setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    const row = this.prompts.get(promptId);
    if (row) row.result = result;
    return Promise.resolve();
  }

  enqueueCreateJob(job: CreateJobRow): Promise<void> {
    this.createJobs.set(job.id, { ...job });
    return Promise.resolve();
  }

  getCreateJob(id: string): Promise<CreateJobRow | null> {
    const job = this.createJobs.get(id);
    return Promise.resolve(job ? { ...job } : null);
  }

  claimNextCreateJob(workerId: string): Promise<CreateJobRow | null> {
    // Oldest queued first; single-process so no real concurrency to guard.
    const queued = [...this.createJobs.values()]
      .filter((j) => j.status === 'queued')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const job = queued[0];
    if (!job) return Promise.resolve(null);
    job.status = 'running';
    job.claimedBy = workerId;
    job.startedAt = new Date().toISOString();
    return Promise.resolve({ ...job });
  }

  completeCreateJob(
    id: string,
    status: 'done' | 'failed',
    result: { boxId?: string; error?: string },
  ): Promise<void> {
    const job = this.createJobs.get(id);
    if (job) {
      job.status = status;
      job.result = result;
      job.finishedAt = new Date().toISOString();
    }
    return Promise.resolve();
  }
}
