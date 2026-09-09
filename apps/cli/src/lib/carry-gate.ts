/**
 * CLI-side wrapper over the shared `carry:` gate.
 *
 * The gate itself (resolve, safety-check, ask) lives in
 * `@agentbox/sandbox-core` so the hub can run the identical decision for a box
 * created from the tray or the web UI. What stays here is the CLI's own
 * context: reading `agentbox.yaml`, the effective size cap, the `--carry-yes` /
 * `AGENTBOX_CARRY` escape hatches, and a terminal asker.
 */

import { log } from '@clack/prompts';
import { loadEffectiveConfig } from '@agentbox/config';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { loadCarrySpec } from '@agentbox/ctl';
import { runCarryGate as runSharedCarryGate, type CarryGateResult } from '@agentbox/sandbox-core';
import { clackAsker } from './ask-clack.js';

export type { CarryGateResult };

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

/**
 * Run the host-side carry gate once for a `create`-style command.
 *
 * Throws on hard resolver errors (non-optional missing src, denylist hit, size
 * cap, ...) so the caller can abort *before* the box is created — and, on a
 * non-TTY without an explicit opt-in, because a silent approval would move host
 * secrets. `-y` alone deliberately does not answer this question.
 */
export async function runCarryGate(args: CarryGateArgs): Promise<CarryGateResult> {
  const { items, replacements } = await loadCarrySpec(args.projectRoot);
  if (items.length === 0) return { decision: 'approve', entries: [] };

  const cfg = await loadEffectiveConfig(args.projectRoot);
  const carryYes = args.carryYesFlag ?? process.env.AGENTBOX_CARRY_YES === '1';
  const carrySkip = args.carrySkipFlag ?? process.env.AGENTBOX_CARRY === 'skip';

  return runSharedCarryGate({
    projectRoot: args.projectRoot,
    items,
    replacements,
    maxBytes: cfg.effective.box.cpMaxBytes,
    ask: clackAsker({ ...(args.onLog ? { onLog: args.onLog } : {}) }),
    carryYes,
    carrySkip,
    ...(args.onLog ? { onLog: args.onLog } : {}),
  });
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
      ...(args.onLog ? { onLog: args.onLog } : {}),
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
