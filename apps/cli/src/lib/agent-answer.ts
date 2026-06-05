// Helpers for answering an agent's IN-TUI prompt (plan-mode approval,
// AskUserQuestion, a generic tool-permission dialog) from the host, used by
// `agentbox agent approve`. Two concerns live here:
//
//   1. Stable, content-derived ids so `approve` is race-safe the same way the
//      relay's host-action prompts are: the orchestrator approves the exact
//      prompt it inspected via `approvals`, and if a *different* prompt has
//      since taken its place the recomputed id won't match, so `approve`
//      refuses instead of answering the wrong thing.
//   2. The (inevitably TUI-version-sensitive, best-effort) mapping from a
//      decision (approve / deny / pick option N) to the tmux keystrokes that
//      enact it. The actual send reuses the `drive` tmux helpers.
//
// In-TUI ids are self-describing — `tui:<boxId>:<kind>:<digest>` — so `approve`
// can resolve the box and recompute the digest without any host-side registry.

import { createHash } from 'node:crypto';
import type { BoxStatusClaude } from '@agentbox/ctl';

export const TUI_ID_PREFIX = 'tui';

/** The kinds of in-TUI block we can address. */
export type InTuiKind = 'plan' | 'question' | 'permission';

/** Which coding agent owns the session (drives keystroke conventions). */
export type AgentKind = 'claude' | 'codex' | 'opencode';

export interface TuiId {
  boxId: string;
  kind: InTuiKind;
  digest: string;
}

/**
 * Classify the box's current in-TUI block from its Claude status snapshot, or
 * null when the agent is not parked on an in-TUI prompt. Plan/question come
 * from the hook-captured payloads; a bare `waiting` state (e.g. the
 * Notification:permission_prompt hook or the screen-scraper fallback) is a
 * generic tool-permission dialog with no structured payload.
 */
export function inTuiKind(claude: BoxStatusClaude): InTuiKind | null {
  // While the agent is busy it isn't parked on a prompt — a still-attached
  // plan/question payload is stale (mirrors `isInputNeeded`'s busy guard).
  if (claude.state === 'working' || claude.state === 'compacting') return null;
  if (claude.plan !== undefined) return 'plan';
  if (claude.question !== undefined) return 'question';
  if (claude.state === 'waiting') return 'permission';
  return null;
}

/**
 * Content digest for the current block. Plan/question hash their captured
 * payload + timestamp, so any change (a new plan, a different question) yields
 * a different id — strong race-safety. A generic permission dialog has no
 * payload, so it can only key on `updatedAt`; race-safety there is weaker (two
 * back-to-back permission prompts can share a digest if no state push landed
 * between them) — documented, and acceptable for the best-effort path.
 */
function digestForBlock(claude: BoxStatusClaude, kind: InTuiKind): string {
  let material: string;
  if (kind === 'plan') {
    material = `plan|${claude.plan?.capturedAt ?? ''}|${claude.plan?.plan ?? ''}`;
  } else if (kind === 'question') {
    material = `question|${claude.question?.capturedAt ?? ''}|${JSON.stringify(claude.question?.questions ?? [])}`;
  } else {
    material = `permission|${claude.updatedAt ?? ''}`;
  }
  return createHash('sha256').update(material).digest('hex').slice(0, 12);
}

/**
 * Mint the id of the box's current in-TUI block, or null when none is pending.
 * Computed identically by `approvals` (to hand the orchestrator an id) and by
 * `approve` (to verify the same prompt is still up).
 */
export function mintTuiId(boxId: string, claude: BoxStatusClaude): { id: string; kind: InTuiKind } | null {
  const kind = inTuiKind(claude);
  if (kind === null) return null;
  return { id: `${TUI_ID_PREFIX}:${boxId}:${kind}:${digestForBlock(claude, kind)}`, kind };
}

/** Parse a `tui:<boxId>:<kind>:<digest>` id, or null when it isn't one. */
export function parseTuiId(id: string): TuiId | null {
  const parts = id.split(':');
  if (parts.length !== 4 || parts[0] !== TUI_ID_PREFIX) return null;
  const [, boxId, kind, digest] = parts;
  if (!boxId || !digest) return null;
  if (kind !== 'plan' && kind !== 'question' && kind !== 'permission') return null;
  return { boxId, kind, digest };
}

/** True when an id addresses an in-TUI prompt (vs a bare relay UUID). */
export function isTuiId(id: string): boolean {
  return id.startsWith(`${TUI_ID_PREFIX}:`);
}

/** A single step to enact against the tmux session. */
export type AnswerStep =
  | { type: 'literal'; value: string }
  | { type: 'key'; value: string }
  | { type: 'delay'; ms: number };

export interface AnswerDecision {
  /** 1-based option to pick (questions / multi-choice permissions). */
  option?: number;
  /** Reject instead of approve. */
  deny?: boolean;
}

/** Delay between typing an option digit and the confirming Enter (TUIs debounce stdin). */
const OPTION_ENTER_DELAY_MS = 150;

/**
 * Map a decision to the keystrokes that enact it. Best-effort and sensitive to
 * each agent's TUI: the default (no option, no deny) accepts the highlighted /
 * first choice, which for both Claude plan-mode and AskUserQuestion is the
 * recommended option (our AskUserQuestion convention puts the recommended
 * option first). `--option N` types the 1-based digit then Enter; `--deny`
 * sends Escape (keep planning / cancel the question / decline the permission).
 */
export function answerKeystrokes(_agent: AgentKind, _kind: InTuiKind, decision: AnswerDecision): AnswerStep[] {
  if (decision.deny === true) {
    return [{ type: 'key', value: 'Escape' }];
  }
  if (decision.option !== undefined) {
    return [
      { type: 'literal', value: String(decision.option) },
      { type: 'delay', ms: OPTION_ENTER_DELAY_MS },
      { type: 'key', value: 'Enter' },
    ];
  }
  return [{ type: 'key', value: 'Enter' }];
}

/**
 * Resolve a `--option <n|label>` value to a 1-based option index for a
 * question block. Numeric input is used as-is; a string is matched
 * case-insensitively against the option labels (exact first, then prefix).
 * Returns null when it can't be resolved (caller errors with the option list).
 */
export function resolveQuestionOption(claude: BoxStatusClaude, raw: string): number | null {
  const options = claude.question?.questions?.[0]?.options ?? [];
  const asNum = Number.parseInt(raw, 10);
  if (Number.isFinite(asNum) && String(asNum) === raw.trim()) {
    return asNum >= 1 && asNum <= options.length ? asNum : null;
  }
  const needle = raw.trim().toLowerCase();
  const exact = options.findIndex((o) => o.label.toLowerCase() === needle);
  if (exact !== -1) return exact + 1;
  const prefix = options.findIndex((o) => o.label.toLowerCase().startsWith(needle));
  return prefix !== -1 ? prefix + 1 : null;
}
