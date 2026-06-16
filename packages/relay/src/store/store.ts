import type { BoxStatusSnapshot } from '../status-store.js';
import type { BoxRegistration, GitRpcResult, PromptAskEvent, RelayEvent } from '../types.js';

/**
 * A pending (or answered) host-action approval, persisted so it survives across
 * stateless function invocations. The blocking laptop relay keeps using the
 * in-process `PendingPrompts`; the hosted control plane (poll mode) parks these
 * rows instead: the box's `/rpc` returns `202 {promptId}`, the human answers via
 * `/admin/prompts/answer`, and the box polls `/rpc/status/:id` until the row is
 * answered — at which point the approved action runs and its result is cached
 * on the row (`result`) so re-polls are idempotent.
 */
export interface PromptRow {
  id: string;
  boxId: string;
  /** What to show the approver (message/detail/context). */
  ev: PromptAskEvent;
  /** The originating `/rpc` method + params, re-dispatched on approval. */
  method: string;
  params: unknown;
  status: 'pending' | 'answered';
  answer?: 'y' | 'n';
  cancelled?: boolean;
  /** Cached result of the approved action (set once executed). */
  result?: GitRpcResult;
  createdAt: string;
  /** ISO-8601 auto-expiry; a poll past this resolves as denied. */
  expiresAt?: string;
}

/** What `POST /remote/boxes` asks the control plane to create. */
export interface CreateJobRequest {
  /** Repo origin URL the new box's workspace is cloned from (via a leased token). */
  repoUrl: string;
  /** Cloud provider to create the box on (e.g. 'e2b', 'vercel', 'daytona', 'hetzner'). */
  provider: string;
  /** Base branch to fork the box's `agentbox/<name>` branch from (default: repo HEAD). */
  branch?: string;
  /** Desired box name (default: generated). */
  name?: string;
  /** Agent to launch (e.g. 'claude'); informational for the worker. */
  agent?: string;
  /** Initial prompt to queue for the agent, if any. */
  prompt?: string;
}

/** A durable box-creation job (the hosted plane's create queue). */
export interface CreateJobRow {
  id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  request: CreateJobRequest;
  /** Set when done/failed. */
  result?: { boxId?: string; error?: string };
  /** Worker id that claimed it (running). */
  claimedBy?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

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

  // --- prompt mailbox (poll-mode approvals; Phase 2) ---
  createPrompt(row: PromptRow): Promise<void>;
  getPrompt(promptId: string): Promise<PromptRow | null>;
  /** pending → answered. Idempotent: returns true only on the first transition. */
  answerPrompt(promptId: string, answer: 'y' | 'n', cancelled?: boolean): Promise<boolean>;
  listPendingPrompts(boxId: string): Promise<PromptRow[]>;
  /** Cache the executed result of an approved action (idempotent re-polls). */
  setPromptResult(promptId: string, result: GitRpcResult): Promise<void>;

  // --- box-create job queue (Phase 5; hosted plane only, hence optional —
  // the federated laptop's RemoteStore omits these, only the plane creates boxes) ---
  enqueueCreateJob?(job: CreateJobRow): Promise<void>;
  getCreateJob?(id: string): Promise<CreateJobRow | null>;
  /** Atomically claim the oldest queued job (→ running), or null when none. */
  claimNextCreateJob?(workerId: string): Promise<CreateJobRow | null>;
  completeCreateJob?(
    id: string,
    status: 'done' | 'failed',
    result: { boxId?: string; error?: string },
  ): Promise<void>;
}
