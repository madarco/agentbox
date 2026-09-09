/**
 * The wire schema for a question AgentBox asks a human before it does something
 * at the host boundary — copying `carry:` files into a box, seeding a box with
 * another agent's login, granting a host CLI.
 *
 * One shape, four front-ends. The CLI renders it with clack, the hub web and the
 * macOS tray render it as a panel, and a future client renders it without either
 * of them changing: a client that understands only {@link PromptRequest} can
 * always ask the question and post a valid answer. {@link PromptDetail} is the
 * opt-in half — a client that recognises a variant draws it properly (a file
 * table, a credential card) and one that does not falls back to its `summary`.
 *
 * The gates that ask are asker-agnostic: they take a {@link PromptAsker} rather
 * than calling a prompt library, so the same gate serves a TTY, an HTTP
 * preflight, and a recorded answer map.
 */

import { createHash } from 'node:crypto';

/** Which widget a client must render. */
export type PromptKind = 'confirm' | 'select' | 'text';

/** One option of a `select`. */
export interface PromptChoice {
  value: string;
  label: string;
  /** Second line, when the option carries a caveat worth reading before picking. */
  hint?: string;
  /** Risky/destructive — a client may style it apart. */
  danger?: boolean;
}

/** One row of a {@link PromptFileTableDetail}. */
export interface PromptFileRow {
  /** Source as the user wrote it, not the realpath. */
  src: string;
  dest: string;
  /** Absent for `missing`. */
  bytes?: number;
  kind: 'file' | 'dir' | 'missing';
  /** Already formatted octal, e.g. `0600`. */
  mode?: string;
  /** Numeric uid, when the entry pins one. */
  user?: number;
  /** Free-form tags: `optional`, `dir`, `symlink-outside-home`. */
  flags: string[];
  /** The row deserves visual weight — it is why the question is being asked. */
  warn?: boolean;
}

/** Files about to be copied somewhere. */
export interface PromptFileTableDetail {
  type: 'file-table';
  summary: string;
  rows: PromptFileRow[];
  totalBytes: number;
}

/** One host login about to be handed to a box. */
export interface PromptCredentialDetail {
  type: 'credential';
  summary: string;
  /** The agent whose login this is (`codex`), not the one consuming it. */
  agent: string;
  label: string;
  caveat?: string;
  hostPath: string;
  boxPath: string;
  bytes?: number;
}

/** Nothing structured to say — `summary` is the whole detail. */
export interface PromptTextDetail {
  type: 'text';
  summary: string;
}

/**
 * Typed extra content a client MAY render richly.
 *
 * Every variant carries `summary`, plain text, so a client that does not know
 * the variant still renders something correct rather than nothing. New variants
 * are therefore additive: an older client degrades, it does not break.
 */
export type PromptDetail = PromptFileTableDetail | PromptCredentialDetail | PromptTextDetail;

/** What an asker does when it cannot reach a human. */
export interface PromptFallback {
  value: string;
  /** Said out loud when the fallback is taken, so it is never a silent default. */
  reason: string;
}

export interface PromptRequest {
  /**
   * `<topic>:<digest>` — content-addressed over the question itself (see
   * {@link promptId}). An answer therefore cannot be replayed onto a question
   * that has since changed: the id no longer matches and the caller refuses.
   */
  id: string;
  /** Machine-stable reason this prompt exists: `carry`, `model-auth`, `tools`. */
  topic: string;
  kind: PromptKind;
  /**
   * Two or three words for a card header ("Copy credentials"), with {@link title}
   * as the line under it. Optional: a client without a header slot — the CLI —
   * shows only `title`, which is always the actual question.
   */
  heading?: string;
  /** The question itself. Always present, and always answerable on its own. */
  title: string;
  body?: string;
  /** Required for `select`; ignored otherwise. */
  choices?: PromptChoice[];
  /** Pre-selected choice / prefilled text. For `confirm`, `'y'` or `'n'`. */
  defaultValue?: string;
  detail?: PromptDetail;
  fallback: PromptFallback;
  /**
   * There is no safe fallback: an asker that cannot reach a human must refuse
   * rather than take `fallback`. Set by prompts whose silent answer would move
   * secrets (`carry:`).
   */
  required?: boolean;
  /**
   * The exact sentence to print when there is no way to ask — the flags or env
   * vars that decide the question up front. Owned by the gate, because only the
   * gate knows its own escape hatches.
   */
  nonInteractiveHint?: string;
}

export interface PromptAnswer {
  id: string;
  value: string;
  /** The user dismissed rather than chose (Esc / closing the panel). */
  cancelled?: boolean;
}

/**
 * The one seam every gate takes instead of calling a prompt library.
 *
 * Implementations: a clack-backed asker in the CLI, a collecting asker that
 * turns a gate into an HTTP preflight, and a map-backed asker that replays the
 * answers a client posted back.
 */
export type PromptAsker = (req: PromptRequest) => Promise<PromptAnswer>;

/**
 * Content-address a question: `<topic>:<12 hex of sha256(topic + payload)>`.
 *
 * `payload` must be canonical — the same question must serialize identically on
 * every run, or a preflight answer would never match the create that replays it.
 * Callers pass a stable projection of what they are asking about (the resolved
 * carry table, the borrow list), never a timestamp or an absolute temp path.
 */
export function promptId(topic: string, payload: unknown): string {
  const digest = createHash('sha256')
    .update(topic)
    .update(' ')
    .update(JSON.stringify(payload) ?? 'null')
    .digest('hex')
    .slice(0, 12);
  return `${topic}:${digest}`;
}

/** True when `id` names this topic — the cheap half of answer validation. */
export function promptTopicOf(id: string): string {
  const i = id.indexOf(':');
  return i === -1 ? id : id.slice(0, i);
}
