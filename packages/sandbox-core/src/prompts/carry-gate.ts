/**
 * The host-boundary gate for a project's `carry:` block: resolve every declared
 * entry, safety-check it, and ask a human before any of it reaches a box.
 *
 * The gate does not know how the question is asked. It builds one
 * {@link PromptRequest} and hands it to a {@link PromptAsker} — clack in the
 * CLI, an HTTP preflight in the hub, a recorded answer map when a client posts
 * its answers back. That is what lets a box created from the tray or the web UI
 * carry the same files a `agentbox create` box does.
 *
 * Parsing stays with the caller (`loadCarrySpec` in `@agentbox/ctl`): this
 * package cannot import ctl, since ctl -> relay -> sandbox-core would cycle.
 */

import {
  promptId,
  type CarryItem,
  type PromptAsker,
  type PromptFileRow,
  type PromptRequest,
  type ReplaceRule,
  type ResolvedCarryEntry,
} from '@agentbox/core';
import { resolveCarry } from './carry-resolve.js';

export const CARRY_TOPIC = 'carry';

/** The three things a user can say about a carry block. */
export type CarryDecision = 'approve' | 'skip-this-run' | 'cancel';

/**
 * The sentence printed when there is no way to ask. Owned here because only the
 * gate knows its own escape hatches.
 */
export const CARRY_NON_INTERACTIVE_HINT =
  'Set AGENTBOX_CARRY_YES=1 to opt in to copying host files into this box, ' +
  'or AGENTBOX_CARRY=skip to skip the carry block.';

export interface CarryGateArgs {
  /** Absolute project root (the dir holding `agentbox.yaml`). */
  projectRoot: string;
  /** Parsed `carry:` entries — see `loadCarrySpec` in `@agentbox/ctl`. */
  items: CarryItem[];
  /** Parsed top-level `replacements:` rule-sets, for expanding `rules:` refs. */
  replacements?: Record<string, ReplaceRule[]>;
  /** Per-entry size cap; callers pass the effective `box.cpMaxBytes`. */
  maxBytes?: number;
  /** How to ask. */
  ask: PromptAsker;
  /** `--carry-yes` / `AGENTBOX_CARRY_YES=1` — approves without asking. */
  carryYes?: boolean;
  /** `--carry skip` / `AGENTBOX_CARRY=skip` — proceeds with carry disabled. */
  carrySkip?: boolean;
  onLog?: (line: string) => void;
}

export type CarryGateResult =
  | { decision: 'approve'; entries: ResolvedCarryEntry[] }
  | { decision: 'skip'; entries: [] }
  | { decision: 'cancel' };

/**
 * Build the question for an already-resolved carry table.
 *
 * Exported so a caller can show the same prompt without re-running the gate —
 * and so the id is derived in exactly one place. The id is content-addressed
 * over what is being asked (src/dest/size/flags per row), so an answer collected
 * in a preflight cannot be replayed onto a `carry:` block that changed in
 * between: the id no longer matches and the create refuses.
 */
export function buildCarryPrompt(entries: ResolvedCarryEntry[]): PromptRequest {
  const rows = entries.map(toFileRow);
  const totalBytes = rows.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const n = rows.length;
  return {
    id: promptId(CARRY_TOPIC, rows),
    topic: CARRY_TOPIC,
    kind: 'select',
    title: `Copy ${String(n)} host ${n === 1 ? 'entry' : 'entries'} into the box?`,
    body:
      'This project declares a `carry:` block. These host files are copied into ' +
      'the box as it is created — anything secret among them leaves your machine.',
    choices: [
      { value: 'approve', label: 'Copy them' },
      { value: 'skip-this-run', label: 'Skip for this box' },
      { value: 'cancel', label: 'Cancel the create', danger: true },
    ],
    defaultValue: 'approve',
    detail: {
      type: 'file-table',
      summary: renderCarryTable(rows),
      rows,
      totalBytes,
    },
    // Silently answering this moves host secrets, so there is no safe default.
    required: true,
    fallback: { value: 'cancel', reason: 'carry: nobody could approve the copy' },
    nonInteractiveHint: CARRY_NON_INTERACTIVE_HINT,
  };
}

/**
 * Run the gate: resolve, safety-check, ask, and return the approved entries.
 *
 * Throws on a hard resolver error (a missing non-optional src, a denylisted
 * dest, an over-cap entry) so the caller aborts *before* a box exists.
 */
export async function runCarryGate(args: CarryGateArgs): Promise<CarryGateResult> {
  const emit = args.onLog ?? (() => {});
  if (args.items.length === 0) return { decision: 'approve', entries: [] };

  const resolved = await resolveCarry(args.items, {
    projectRoot: args.projectRoot,
    ...(args.maxBytes !== undefined ? { maxBytes: args.maxBytes } : {}),
    ...(args.replacements ? { replacements: args.replacements } : {}),
  });
  if (resolved.errors.length > 0) {
    throw new Error(
      ['carry: refused to proceed:', ...resolved.errors.map((e) => `  - ${e}`)].join('\n'),
    );
  }

  // Flags decide the question before anyone is asked, so a scripted create never
  // surfaces a prompt it has already been told the answer to.
  if (args.carrySkip) return skip(resolved.entries.length, emit);
  if (args.carryYes) return { decision: 'approve', entries: resolved.entries };

  const req = buildCarryPrompt(resolved.entries);
  const answer = await args.ask(req);
  const decision: CarryDecision = answer.cancelled
    ? 'cancel'
    : isCarryDecision(answer.value)
      ? answer.value
      : 'cancel';

  if (decision === 'cancel') return { decision: 'cancel' };
  if (decision === 'skip-this-run') return skip(resolved.entries.length, emit);
  return { decision: 'approve', entries: resolved.entries };
}

function skip(count: number, emit: (line: string) => void): { decision: 'skip'; entries: [] } {
  emit(`carry: skipped for this box (${String(count)} entry/entries not copied)`);
  return { decision: 'skip', entries: [] };
}

function isCarryDecision(v: string): v is CarryDecision {
  return v === 'approve' || v === 'skip-this-run' || v === 'cancel';
}

/** Project one resolved entry into the wire row every client renders. */
export function toFileRow(e: ResolvedCarryEntry): PromptFileRow {
  const flags: string[] = [];
  if (e.kind === 'missing' || e.optional) flags.push('optional');
  if (e.kind === 'dir') flags.push('dir');
  if (e.symlinkInfo === 'outside-home') flags.push('symlink-outside-home');
  return {
    src: e.rawSrc,
    dest: e.rawDest,
    ...(e.kind === 'missing' ? {} : { bytes: e.bytes ?? 0 }),
    kind: e.kind,
    ...(e.mode !== undefined ? { mode: e.mode.toString(8).padStart(4, '0') } : {}),
    // Unset means "the box user", the calm common case. Any explicit `user:` is
    // an override worth seeing at the gate — including a literal 1000.
    ...(e.user !== undefined ? { user: e.user } : {}),
    flags,
    // The only flag that says "this may not be what you think it is".
    ...(e.symlinkInfo === 'outside-home' ? { warn: true } : {}),
  };
}

/**
 * The plain-text table, for a client that renders no typed detail (and for the
 * CLI, which renders exactly this). Kept beside `toFileRow` so the columns and
 * the flags can never disagree.
 */
export function renderCarryTable(rows: PromptFileRow[]): string {
  if (rows.length === 0) return '';
  const srcW = Math.max(3, ...rows.map((r) => r.src.length));
  const destW = Math.max(4, ...rows.map((r) => r.dest.length));
  const out = [`${pad('src', srcW)}  ->  ${pad('dest', destW)}  size       flags`];
  for (const r of rows) {
    const flags = [...r.flags];
    if (r.mode !== undefined) flags.push(`mode ${r.mode}`);
    if (r.user !== undefined) flags.push(`user ${String(r.user)}`);
    const size = r.kind === 'missing' ? '-' : formatBytes(r.bytes ?? 0);
    out.push(
      `${pad(r.src, srcW)}  ->  ${pad(r.dest, destW)}  ${pad(size, 9)}  ${flags.join(', ')}`,
    );
  }
  return out.join('\n');
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : String(Math.round(v))} ${units[i]!}`;
}
