import { isCancel, log, select } from '@clack/prompts';
import { fmtBytes } from './fmt.js';
import type { ResolvedCarryEntry } from './lib/carry-resolve.js';

export type CarryDecision = 'approve' | 'cancel' | 'skip-this-run';

export interface CarryPromptArgs {
  resolved: ResolvedCarryEntry[];
  /** --carry-yes flag (or AGENTBOX_CARRY_YES=1) — auto-approves the carry. */
  carryYes?: boolean;
  /** --carry=skip flag (or AGENTBOX_CARRY=skip) — proceed with carry disabled. */
  carrySkip?: boolean;
  /** The generic --yes / -y flag (does NOT auto-approve carry). */
  yes?: boolean;
  /** Caller-controlled TTY check; default: process.stdin.isTTY. */
  isTTY?: boolean;
}

/**
 * Decide whether to carry the resolved entries. Caller invokes this once per
 * `create`-style command. The returned decision tells the caller to proceed
 * with the entries, skip them, or abort the whole create.
 *
 * Throws when `--yes` is passed on a non-TTY with non-empty carry entries —
 * `-y` MUST NOT silently exfiltrate host secrets. The error message tells the
 * user the explicit env var to set.
 */
export async function promptForCarry(args: CarryPromptArgs): Promise<CarryDecision> {
  // Empty carry: nothing to ask. Always approve so the caller's branch is
  // uniform ("if decision === 'approve' && entries.length") regardless of
  // whether the user has a carry: block at all.
  if (args.resolved.length === 0) return 'approve';

  if (args.carrySkip) return 'skip-this-run';
  if (args.carryYes) return 'approve';

  const tty = args.isTTY ?? process.stdin.isTTY;

  if (args.yes) {
    if (!tty) {
      throw new Error(
        'carry: requires approval but stdin is not a TTY and --carry-yes was not set. ' +
          'In CI, set AGENTBOX_CARRY_YES=1 to opt in to copying host secrets/files into this box, ' +
          'or AGENTBOX_CARRY=skip to skip the carry block.',
      );
    }
    // -y on a TTY still falls through to the prompt — the prompt is the
    // user's explicit gate, not a "wizard default".
  }

  if (!tty) {
    throw new Error(
      'carry: requires approval but stdin is not a TTY. ' +
        'Set AGENTBOX_CARRY_YES=1 to opt in, or AGENTBOX_CARRY=skip to skip.',
    );
  }

  printSummary(args.resolved);

  const choice = await select<CarryDecision>({
    message: 'Copy these files inside the box?',
    options: [
      { value: 'approve', label: 'yes' },
      { value: 'skip-this-run', label: 'skip' },
      { value: 'cancel', label: 'cancel' },
    ],
    initialValue: 'approve',
  });

  if (isCancel(choice)) return 'cancel';
  return choice;
}

function printSummary(entries: ResolvedCarryEntry[]): void {
  const rows: string[] = [];
  const srcW = Math.max(3, ...entries.map((e) => e.rawSrc.length));
  const destW = Math.max(4, ...entries.map((e) => e.rawDest.length));
  rows.push(`  ${pad('src', srcW)}  →  ${pad('dest', destW)}  size       flags`);
  for (const e of entries) {
    const flags: string[] = [];
    if (e.kind === 'missing') flags.push('optional');
    else if (e.optional) flags.push('optional');
    if (e.kind === 'dir') flags.push('dir');
    if (e.mode !== undefined) flags.push(`mode ${e.mode.toString(8).padStart(4, '0')}`);
    if (e.symlinkInfo === 'outside-home') flags.push('symlink → outside $HOME!');
    const size = e.kind === 'missing' ? '—' : fmtBytes(e.bytes ?? 0);
    rows.push(
      `  ${pad(e.rawSrc, srcW)}  →  ${pad(e.rawDest, destW)}  ${pad(size, 9)}  ${flags.join(', ')}`,
    );
  }
  log.message(rows.join('\n'));
}

function pad(s: string, w: number): string {
  if (s.length >= w) return s;
  return s + ' '.repeat(w - s.length);
}
