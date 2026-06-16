import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, RelayEvent } from '../types.js';

/**
 * The relay's persisted-state seam.
 *
 * Historically the relay held all its state in process memory (`BoxRegistry`,
 * `EventBuffer`, `BoxStatusStore`, …). That is fine for the laptop loopback
 * relay — one always-on process — but a control plane that runs on serverless
 * functions (or a horizontally-scaled container) has no shared process memory,
 * so its state must live in an external store. `Store` is the interface every
 * relay handler talks to; the deployment chooses the implementation:
 *
 *   - {@link MemoryStore}   — wraps the in-memory structures; the laptop relay
 *                             default and the unit-test default (zero behavior
 *                             change vs the pre-seam relay).
 *   - PostgresStore (Phase 1) — Vercel / self-host hosted control plane.
 *   - RemoteStore  (Phase 4b) — a federated laptop relay forwarding its state
 *                             to a hosted control plane over HTTP.
 *
 * Every method is async so the same handler code runs over an in-memory map or
 * a SQL round-trip without change. Phase 0 covers boxes + events + status; the
 * prompt mailbox (Phase 2), host-initiated tokens (Phase 3), and the box-create
 * job queue (Phase 5) extend this interface in their own phases.
 */
export interface Store {
  // --- boxes (was BoxRegistry) ---
  registerBox(reg: BoxRegistration): Promise<void>;
  getBox(boxId: string): Promise<BoxRegistration | undefined>;
  /** Returns the registration whose token matches, or null. */
  authenticateBox(token: string): Promise<BoxRegistration | null>;
  listBoxes(): Promise<BoxRegistration[]>;
  forgetBox(boxId: string): Promise<boolean>;
  countBoxes(): Promise<number>;

  // --- events (was EventBuffer) ---
  appendEvent(input: Omit<RelayEvent, 'id' | 'receivedAt'>): Promise<RelayEvent>;
  /** Events with id > since. If `boxId` is given, filters to that box. */
  listEvents(since: number, boxId?: string): Promise<RelayEvent[]>;
  countEvents(): Promise<number>;

  // --- status (was BoxStatusStore) ---
  setStatus(
    boxId: string,
    name: string,
    projectIndex: number | undefined,
    status: BoxStatusSnapshot,
  ): Promise<void>;
  getStatus(boxId: string): Promise<BoxStatusSnapshot | undefined>;
  deleteStatus(boxId: string): Promise<void>;
}
