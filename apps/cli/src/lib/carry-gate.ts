import { join } from 'node:path';
import { log } from '@clack/prompts';
import { loadCarrySection } from '@agentbox/ctl';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { promptForCarry } from '../carry-prompt.js';
import { resolveCarry } from './carry-resolve.js';

export interface CarryGateArgs {
  /** Absolute project root (dir holding agentbox.yaml). */
  projectRoot: string;
  /** `-y` / `--yes` — does NOT auto-approve carry. */
  yes: boolean;
  /** `--carry-yes` or AGENTBOX_CARRY_YES=1 — auto-approves. */
  carryYesFlag?: boolean;
  /** `--carry skip` or AGENTBOX_CARRY=skip — skip carry for this run. */
  carrySkipFlag?: boolean;
  onLog?: (line: string) => void;
}

export type CarryGateResult =
  | { decision: 'approve'; entries: ResolvedCarryEntry[] }
  | { decision: 'skip'; entries: [] }
  | { decision: 'cancel' };

/**
 * Run the host-side carry gate once for a `create`-style command:
 * 1. read `<projectRoot>/agentbox.yaml`'s `carry:` block (empty when missing),
 * 2. resolve + safety-check each entry,
 * 3. prompt the user (or honor --carry-yes / --carry=skip / env vars),
 * 4. return the approved entries (or signal cancel).
 *
 * Throws on hard resolver errors (non-optional missing src, denylist hit, size
 * cap, etc.) so the caller can abort *before* the box is created.
 */
export async function runCarryGate(args: CarryGateArgs): Promise<CarryGateResult> {
  const emit = args.onLog ?? (() => {});
  const yamlPath = join(args.projectRoot, 'agentbox.yaml');

  const items = await loadCarrySection(yamlPath);
  if (items.length === 0) return { decision: 'approve', entries: [] };

  const resolved = await resolveCarry(items, { projectRoot: args.projectRoot });
  if (resolved.errors.length > 0) {
    const msg = ['carry: refused to proceed:', ...resolved.errors.map((e) => `  - ${e}`)].join('\n');
    throw new Error(msg);
  }

  const carryYesEnv = process.env.AGENTBOX_CARRY_YES === '1';
  const carrySkipEnv = process.env.AGENTBOX_CARRY === 'skip';
  const carryYes = args.carryYesFlag ?? carryYesEnv;
  const carrySkip = args.carrySkipFlag ?? carrySkipEnv;

  const decision = await promptForCarry({
    resolved: resolved.entries,
    yes: args.yes,
    carryYes,
    carrySkip,
  });

  if (decision === 'cancel') return { decision: 'cancel' };
  if (decision === 'skip-this-run') {
    emit(`carry: skipped for this box (${String(resolved.entries.length)} entry/entries not copied)`);
    return { decision: 'skip', entries: [] };
  }
  return { decision: 'approve', entries: resolved.entries };
}

/**
 * `-i` (queued background run) variant: run the same host-side gate the
 * foreground create runs, but instead of threading the result through inline
 * branches, return the approved entries (empty on skip) and exit the process on
 * cancel / hard error — the queue submitter has nothing to clean up yet. The
 * approved entries are serialized into the queue job and applied by the worker.
 */
export async function runQueuedCarryGate(args: {
  projectRoot: string;
  opts: { yes?: boolean; carryYes?: boolean; carry?: string };
  onLog?: (line: string) => void;
  onClose?: () => void;
}): Promise<ResolvedCarryEntry[]> {
  try {
    const gate = await runCarryGate({
      projectRoot: args.projectRoot,
      yes: !!args.opts.yes,
      carryYesFlag: args.opts.carryYes ? true : undefined,
      carrySkipFlag: args.opts.carry === 'skip' ? true : undefined,
      onLog: args.onLog,
    });
    if (gate.decision === 'cancel') {
      log.warn('carry: cancelled — not queuing the job');
      args.onClose?.();
      process.exit(0);
    }
    return gate.decision === 'approve' ? gate.entries : [];
  } catch (err) {
    log.error(err instanceof Error ? err.message : String(err));
    args.onClose?.();
    process.exit(1);
  }
}
