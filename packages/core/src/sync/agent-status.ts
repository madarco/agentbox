/**
 * The per-agent activity/status contract, shared by every hop between the in-box
 * ctl daemon and the hub's `/api/v1` payload.
 *
 * WHY IT LIVES IN `@agentbox/core`: `ctl` depends on `relay`, never the reverse,
 * and `core` is the zero-internal-dep leaf both can reach. `ctl` owns the
 * `BoxStatus` envelope (it is the producer); the per-agent *entry* has to be
 * readable by the relay's queue gate and by the hub without either importing the
 * box daemon.
 *
 * WHY A KEYED MAP AND NOT NAMED FIELDS: `BoxStatus` used to carry a required
 * `claude` plus optional `codex`/`opencode`, and every consumer re-spelled those
 * three names. A fourth agent could not report activity at all — not "was not
 * wired up", but had nowhere to put the value. Keyed by {@link AgentId}, a new
 * agent reports activity the moment it has a registry row.
 *
 * BACK-COMPAT IS READ-TIME, exactly as {@link normalizeLastAgent} does it for
 * persisted agent names, and for the same reason: the producer is BAKED INTO THE
 * BOX IMAGE. A box created from an older snapshot keeps posting the old shape
 * for as long as it lives, and no host-side release can change that. So the old
 * shape is normalized on the way in ({@link normalizeAgentStatus}) rather than
 * migrated, and the current producer keeps WRITING the legacy blocks too, since
 * the skew runs both ways (a laptop CLI can be newer than a control box's hub).
 *
 * THE SCHEMA VERSION DOES NOT MOVE. `BoxStatus.schema` is `1`, and both
 * `isValidBoxStatus` (relay) and `readBoxStatus` (host) reject anything else
 * outright — a bump would silently blank every field on every existing host
 * rather than degrade. `agents` is therefore an ADDITIVE field, the same
 * discipline `probed`, `expose` and `sessionTitle` already follow on this type.
 */

import type { AgentId } from './agent-kind.js';

/**
 * Coarse activity state of an in-box agent session. `unknown` is the initial
 * value, before any hook/plugin/scraper has reported (or for a box whose image
 * predates the reporting).
 *
 * `end-plan` and `question` are the fine-grained, payload-bearing states: the
 * agent is awaiting human approval of a plan, or showing an interactive
 * question. `compacting` means the conversation is being summarized; `error`
 * that a turn ended in an unrecoverable failure.
 */
export type AgentActivityState =
  | 'working'
  | 'idle'
  | 'waiting'
  | 'end-plan'
  | 'question'
  | 'compacting'
  | 'error'
  | 'unknown';

export const AGENT_ACTIVITY_STATES: readonly AgentActivityState[] = [
  'working',
  'idle',
  'waiting',
  'end-plan',
  'question',
  'compacting',
  'error',
  'unknown',
];

export function isAgentActivityState(v: unknown): v is AgentActivityState {
  return typeof v === 'string' && (AGENT_ACTIVITY_STATES as readonly string[]).includes(v);
}

/** Body captured from a plan-approval hook payload. */
export interface AgentPlanPayload {
  /** Markdown plan body. */
  plan: string;
  /** ISO-8601 timestamp the hook fired. */
  capturedAt: string;
}

/** Body captured from an interactive-question hook payload. */
export interface AgentQuestionPayload {
  /** Each entry is one question the agent is asking; usually length 1. */
  questions: Array<{
    question: string;
    header?: string;
    multiSelect?: boolean;
    options: Array<{ label: string; description?: string }>;
  }>;
  capturedAt: string;
}

/**
 * One agent's status inside a box.
 *
 * Uniform across agents on purpose. `plan`/`question` are not Claude-specific —
 * only Claude *produces* them today, because only its hooks carry the payload —
 * so an agent that grows the same hooks needs no new field and no new reader.
 */
export interface AgentStatusEntry {
  state: AgentActivityState;
  /** ISO-8601 time the last state report arrived, or null if none yet. */
  updatedAt: string | null;
  /** Whether the agent's tmux session was present at snapshot time. */
  sessionRunning: boolean;
  /** Sanitized in-box tmux pane title the agent's TUI set. Additive. */
  sessionTitle?: string;
  /** Populated while `state === 'end-plan'`; cleared by the matching post-hook. */
  plan?: AgentPlanPayload;
  /** Populated while `state === 'question'`; cleared by the matching post-hook. */
  question?: AgentQuestionPayload;
}

/** Every reporting agent in one box, keyed by {@link AgentId}. */
export type AgentStatusMap = Record<AgentId, AgentStatusEntry>;

/**
 * The legacy per-agent field names on `BoxStatus`, in the order a reader should
 * prefer them. Frozen: this is the set of names old producers actually wrote, so
 * it never grows — a fourth agent lives only in `agents`.
 */
export const LEGACY_AGENT_STATUS_KEYS: readonly AgentId[] = ['claude', 'codex', 'opencode'];

/**
 * Narrow one agent's body from an untrusted payload, or null if it isn't one.
 *
 * Deliberately lenient about everything except `state`: an entry whose `state`
 * is unrecognizable is not an entry, but a missing `updatedAt` or a garbage
 * `sessionTitle` is dropped field-by-field rather than failing the whole box.
 * A newer producer's extra fields are ignored, never rejected.
 */
export function parseAgentStatusEntry(raw: unknown): AgentStatusEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!isAgentActivityState(o.state)) return null;
  const entry: AgentStatusEntry = {
    state: o.state,
    updatedAt: typeof o.updatedAt === 'string' ? o.updatedAt : null,
    sessionRunning: o.sessionRunning === true,
  };
  if (typeof o.sessionTitle === 'string' && o.sessionTitle.length > 0) {
    entry.sessionTitle = o.sessionTitle;
  }
  const plan = o.plan as Record<string, unknown> | undefined;
  if (plan && typeof plan === 'object' && typeof plan.plan === 'string') {
    entry.plan = {
      plan: plan.plan,
      capturedAt: typeof plan.capturedAt === 'string' ? plan.capturedAt : '',
    };
  }
  const question = o.question as Record<string, unknown> | undefined;
  if (question && typeof question === 'object' && Array.isArray(question.questions)) {
    entry.question = {
      questions: question.questions as AgentQuestionPayload['questions'],
      capturedAt: typeof question.capturedAt === 'string' ? question.capturedAt : '',
    };
  }
  return entry;
}

/**
 * Read the agent status map out of a box-status payload of ANY vintage.
 *
 * Accepts both shapes and always answers the map:
 *  - a current producer's `agents: { … }`, and
 *  - an older producer's `claude` / `codex` / `opencode` blocks.
 *
 * `agents` WINS where both are present, because the current producer writes the
 * legacy blocks as a derived mirror — so on a mixed payload the map is the
 * source and the mirror is the copy. Unknown agent ids inside `agents` are kept:
 * a newer box may report an agent this host has never heard of, and dropping it
 * would make `list` claim the box is idle.
 *
 * Never throws — a malformed payload yields `{}`, never a crash in `list`.
 */
export function normalizeAgentStatus(raw: unknown): AgentStatusMap {
  if (raw === null || typeof raw !== 'object') return {};
  const o = raw as Record<string, unknown>;
  const out: AgentStatusMap = {};

  // Legacy blocks first, so `agents` overwrites them on a dual-shape payload.
  for (const key of LEGACY_AGENT_STATUS_KEYS) {
    const entry = parseAgentStatusEntry(o[key]);
    if (entry) out[key] = entry;
  }

  const agents = o.agents;
  if (agents !== null && typeof agents === 'object') {
    for (const [id, body] of Object.entries(agents as Record<string, unknown>)) {
      if (id.length === 0) continue;
      const entry = parseAgentStatusEntry(body);
      if (entry) out[id] = entry;
    }
  }
  return out;
}

/**
 * The legacy mirror a current producer writes beside `agents`, so a host or hub
 * older than this build keeps reading activity. DERIVED, never hand-maintained —
 * a test asserts it moves with the map.
 *
 * Only the frozen legacy names are mirrored: an old reader has no field for a
 * fourth agent, and inventing one would not help it.
 */
export function legacyAgentStatusFields(map: AgentStatusMap): Record<string, AgentStatusEntry> {
  const out: Record<string, AgentStatusEntry> = {};
  for (const key of LEGACY_AGENT_STATUS_KEYS) {
    const entry = map[key];
    if (entry) out[key] = entry;
  }
  return out;
}

/**
 * The agent a box should be judged by when a caller wants exactly one: whichever
 * reports a quota-consuming state, else the most recently updated.
 *
 * Shared so the queue's working-gate, `list`'s AGENT column and the dashboard
 * cannot disagree about which agent a box "is" — they each used to re-implement
 * this over the same three hardcoded names.
 */
export function pickPrimaryAgent(
  map: AgentStatusMap,
): { agent: AgentId; entry: AgentStatusEntry } | null {
  const entries = Object.entries(map).map(([agent, entry]) => ({ agent, entry }));
  if (entries.length === 0) return null;
  const busy = entries.find((e) => e.entry.state === 'working' || e.entry.state === 'compacting');
  if (busy) return busy;
  entries.sort((a, b) => parseTime(b.entry.updatedAt) - parseTime(a.entry.updatedAt));
  return entries[0] ?? null;
}

function parseTime(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
