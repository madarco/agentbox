// Pure helpers for the skills table's hub <-> PC columns: the status label, which
// move each row offers, and what "Sync all" does. Kept out of the page so they
// are unit-tested.
import type { CompareRow, PullResult, SendResult } from './api';

export type PcMove = 'pull' | 'send';

/** The Status column's words for one row. */
export function statusLabel(row: CompareRow, machine: string, online: boolean): string {
  switch (row.status) {
    case 'same':
      return `On Hub and ${machine}`;
    case 'differs':
      return row.newer === 'local'
        ? `Differs · newer on ${machine}`
        : row.newer === 'hub'
          ? 'Differs · newer on Hub'
          : 'Differs';
    case 'local-only':
      return `Only on ${machine}`;
    case 'hub-only':
      return 'Only on Hub';
    case 'skipped':
      return 'Skipped, not synced';
    default:
      return online ? 'Unknown' : `${machine} offline`;
  }
}

/**
 * The moves a row offers: both ways for `differs`, the one that fixes it
 * otherwise, none for a skipped one (the hub refuses those).
 */
export function rowMoves(row: CompareRow): PcMove[] {
  if (row.status === 'local-only') return ['pull'];
  if (row.status === 'hub-only') return ['send'];
  // A PC copy with problems is never replaced from here: it couldn't be read
  // whole (too big, unreadable), so nobody has seen what a send would delete.
  if (row.status === 'differs') return pullBlocker(row) ? ['pull'] : ['pull', 'send'];
  return [];
}

/** Why a PC copy can't be pulled as is (problems only; findings can be overridden). */
export function pullBlocker(row: CompareRow): string | null {
  return row.pc && row.pc.problems.length > 0 ? row.pc.problems.join('; ') : null;
}

export interface SyncPlan {
  pull: string[];
  send: string[];
  /** `send` entries that replace a different copy on the machine. */
  overwrite: string[];
  /** Out of sync but left alone, and why. */
  skipped: { name: string; reason: string }[];
}

/**
 * "Sync all": a PC-only skill goes to the hub, a hub-only one to the PC, and a
 * differing one moves from the side that changed last. A PC copy that can't be
 * uploaded (problems or secret-scan findings) is left for the row's own button,
 * and one with problems is never overwritten.
 */
export function syncPlan(rows: readonly CompareRow[]): SyncPlan {
  const plan: SyncPlan = { pull: [], send: [], overwrite: [], skipped: [] };
  for (const r of rows) {
    const toHub = r.status === 'local-only' || (r.status === 'differs' && r.newer === 'local');
    const toPc = r.status === 'hub-only' || (r.status === 'differs' && r.newer === 'hub');
    if (r.status === 'differs' && r.newer === undefined) {
      plan.skipped.push({ name: r.name, reason: 'no way to tell which side is newer' });
    } else if (toHub) {
      const blocked = pullBlocker(r);
      if (blocked) plan.skipped.push({ name: r.name, reason: blocked });
      else if ((r.pc?.findings.length ?? 0) > 0)
        plan.skipped.push({ name: r.name, reason: 'secret-scan findings' });
      else plan.pull.push(r.name);
    } else if (toPc) {
      const blocked = pullBlocker(r);
      if (blocked) {
        plan.skipped.push({ name: r.name, reason: blocked });
        continue;
      }
      plan.send.push(r.name);
      if (r.status === 'differs') plan.overwrite.push(r.name);
    }
  }
  return plan;
}

/** One line per result, for the notice under the toolbar. */
export function resultLine(r: PullResult | SendResult, machine: string): string {
  switch (r.status) {
    case 'imported':
      return `${r.name}: pulled to the Hub`;
    case 'held':
      return `${r.name}: pulled; waiting for approval`;
    case 'unchanged':
      return `${r.name}: already the same`;
    case 'installed':
    case 'replaced':
      return `${r.name}: ${r.status} on ${machine}${r.kept?.length ? ` (an agent still reads its own copy at ${r.kept.join(', ')})` : ''}`;
    default:
      return `${r.name}: ${r.status} — ${r.reason}`;
  }
}
