import type { BoxRegistry, EventBuffer } from '../registry.js';
import type { BoxStatusSnapshot, BoxStatusStore } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, RelayEvent } from '../types.js';
import type { CreateJobRow, PromptRow, Store } from './store.js';

export interface WriteThroughParts {
  registry: BoxRegistry;
  events: EventBuffer;
  statusStore: BoxStatusStore;
}

/** A durable store that also exposes the off-interface bulk-status read. */
interface StoreWithStatuses extends Store {
  listStatuses?(): Promise<Array<{ boxId: string; status: BoxStatusSnapshot }>>;
  prunePrompts?(beforeIso: string): Promise<number>;
  pruneCreateJobs?(beforeIso: string): Promise<number>;
}

/**
 * Wraps a durable {@link Store} (SQLite / Postgres) and mirrors every mutating
 * call into the in-process `BoxRegistry` / `EventBuffer` / `BoxStatusStore` the
 * relay handle exposes.
 *
 * Why this exists: the daemon's background loops (autopause, cloud-keepalive,
 * queue) and the hub backend read those concrete instances *synchronously*, not
 * the async `Store`. On the laptop that is fine — `MemoryStore` IS those
 * instances. But a control box injects a durable store, and without this wrapper
 * the handlers would write to SQLite while the instances stay empty, so
 * cloud-keepalive would never see a box and the hub UI would show no status.
 *
 * The durable store stays the source of truth (it survives restarts); the
 * in-memory instances are a within-process cache kept in lock-step by
 * write-through + a one-time {@link hydrate} on boot. The control box runs a
 * single hub process (SQLite single-writer, per phase 1), so no other writer can
 * make the mirror stale. Reads are pure delegation to the durable store.
 */
export class WriteThroughStore implements Store {
  private readonly inner: StoreWithStatuses;
  private readonly registry: BoxRegistry;
  private readonly events: EventBuffer;
  private readonly statusStore: BoxStatusStore;

  constructor(inner: Store, parts: WriteThroughParts) {
    this.inner = inner;
    this.registry = parts.registry;
    this.events = parts.events;
    this.statusStore = parts.statusStore;
  }

  /**
   * Load the durable store's boxes + statuses into the in-memory instances, once
   * at boot, so the loops start against a populated registry after a restart.
   * Events are a ring buffer (ephemeral) and are not hydrated.
   */
  async hydrate(): Promise<void> {
    for (const reg of await this.inner.listBoxes()) this.registry.register(reg);
    if (this.inner.listStatuses) {
      for (const { boxId, status } of await this.inner.listStatuses()) {
        const reg = this.registry.get(boxId);
        await this.statusStore.set(boxId, reg?.name ?? boxId, reg?.projectIndex, status);
      }
    }
  }

  migrate(): Promise<void> {
    return this.inner.migrate?.() ?? Promise.resolve();
  }

  // --- boxes ---

  async registerBox(reg: BoxRegistration): Promise<void> {
    await this.inner.registerBox(reg);
    this.registry.register(reg);
  }

  getBox(boxId: string): Promise<BoxRegistration | undefined> {
    return this.inner.getBox(boxId);
  }

  authenticateBox(token: string): Promise<BoxRegistration | null> {
    return this.inner.authenticateBox(token);
  }

  listBoxes(): Promise<BoxRegistration[]> {
    return this.inner.listBoxes();
  }

  async forgetBox(boxId: string): Promise<boolean> {
    const existed = await this.inner.forgetBox(boxId);
    this.registry.forget(boxId);
    return existed;
  }

  countBoxes(): Promise<number> {
    return this.inner.countBoxes();
  }

  // --- events ---

  async appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent> {
    const ev = await this.inner.appendEvent(input);
    // The mirror ring keeps its own id sequence; the loops only read box/type/ts,
    // never cross-reference the durable id, so the divergence is harmless.
    this.events.append(input);
    return ev;
  }

  listEvents(since: number, boxId?: string): Promise<RelayEvent[]> {
    return this.inner.listEvents(since, boxId);
  }

  countEvents(): Promise<number> {
    return this.inner.countEvents();
  }

  // --- status ---

  async setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void> {
    await this.inner.setStatus(boxId, name, projectIndex, status);
    await this.statusStore.set(boxId, name, projectIndex, status);
  }

  getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined> {
    return this.inner.getStatus(boxId);
  }

  async deleteStatus(boxId: string): Promise<void> {
    await this.inner.deleteStatus(boxId);
    this.statusStore.delete(boxId);
  }

  /** Off-interface bulk read (postgres-source.ts) — forwarded for parity. */
  listStatuses(): Promise<Array<{ boxId: string; status: BoxStatusSnapshot }>> {
    return this.inner.listStatuses?.() ?? Promise.resolve([]);
  }

  // --- prompt mailbox (pure delegation; no in-memory mirror the loops read) ---

  createPrompt(row: PromptRow): Promise<void> {
    return this.inner.createPrompt(row);
  }

  getPrompt(promptId: string): Promise<PromptRow | null> {
    return this.inner.getPrompt(promptId);
  }

  answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean> {
    return this.inner.answerPrompt(promptId, answer, cancelled);
  }

  listPendingPrompts(boxId: string): Promise<PromptRow[]> {
    return this.inner.listPendingPrompts(boxId);
  }

  setPromptResult(promptId: string, result: GitRpcResult): Promise<void> {
    return this.inner.setPromptResult(promptId, result);
  }

  // --- box-create job queue (pure delegation) ---

  enqueueCreateJob(job: CreateJobRow): Promise<void> {
    if (!this.inner.enqueueCreateJob) return Promise.resolve();
    return this.inner.enqueueCreateJob(job);
  }

  getCreateJob(id: string): Promise<CreateJobRow | null> {
    return this.inner.getCreateJob?.(id) ?? Promise.resolve(null);
  }

  claimNextCreateJob(workerId: string): Promise<CreateJobRow | null> {
    return this.inner.claimNextCreateJob?.(workerId) ?? Promise.resolve(null);
  }

  completeCreateJob(
    id: string,
    status: 'done' | 'failed',
    result: { boxId?: string; error?: string },
  ): Promise<void> {
    if (!this.inner.completeCreateJob) return Promise.resolve();
    return this.inner.completeCreateJob(id, status, result);
  }

  // --- retention (forwarded; blocker B) ---

  prunePrompts(beforeIso: string): Promise<number> {
    return this.inner.prunePrompts?.(beforeIso) ?? Promise.resolve(0);
  }

  pruneCreateJobs(beforeIso: string): Promise<number> {
    return this.inner.pruneCreateJobs?.(beforeIso) ?? Promise.resolve(0);
  }
}
