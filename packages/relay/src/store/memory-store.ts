import { BoxRegistry, EventBuffer } from '../registry.js';
import { BoxStatusStore } from '../status-store.js';
import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, RelayEvent } from '../types.js';
import type { Store } from './store.js';

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
}
