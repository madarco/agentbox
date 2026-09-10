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
import { loadEffectiveConfig, readCarryGrant, writeCarryGrant } from '@agentbox/config';
import type { ResolvedCarryEntry } from '@agentbox/core';
import { loadCarrySpec } from '@agentbox/ctl';
import {
  runCarryGate as runSharedCarryGate,
  toFileRow,
  type CarryGateResult,
} from '@agentbox/sandbox-core';
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
  /** `--carry ask` — re-open the decision even though the list is already granted. */
  carryAskFlag?: boolean;
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
  // The standing approval for this project's list, if it has one. Read here
  // rather than in the shared gate so that package never touches ~/.agentbox.
  const granted = await readCarryGrant(args.projectRoot);

  const result = await runSharedCarryGate({
    projectRoot: args.projectRoot,
    items,
    replacements,
    maxBytes: cfg.effective.box.cpMaxBytes,
    ask: clackAsker({ ...(args.onLog ? { onLog: args.onLog } : {}) }),
    carryYes,
    carrySkip,
    ...(granted ? { approvedGrantId: granted.approvedId } : {}),
    ...(args.carryAskFlag ? { carryAsk: true } : {}),
    ...(args.onLog ? { onLog: args.onLog } : {}),
  });

  // Store only a fresh HUMAN approval: `fromGrant` is already stored, and
  // `--carry-yes` is a one-shot bypass that must not leave a standing grant.
  if (result.decision === 'approve' && result.grantId && !result.fromGrant && !carryYes) {
    await recordGrant(args.projectRoot, result.grantId, result.entries);
  }
  return result;
}

/** Persist the approved list. Best-effort: a create must not fail over a memo. */
async function recordGrant(
  projectRoot: string,
  approvedId: string,
  entries: ResolvedCarryEntry[],
): Promise<void> {
  try {
    await writeCarryGrant(projectRoot, {
      approvedId,
      approvedAt: new Date().toISOString(),
      files: entries.map((e) => {
        const row = toFileRow(e);
        return {
          src: row.src,
          dest: row.dest,
          kind: row.kind,
          ...(row.mode !== undefined ? { mode: row.mode } : {}),
          ...(row.user !== undefined ? { user: row.user } : {}),
          ...(row.flags.length > 0 ? { flags: row.flags } : {}),
        };
      }),
    });
  } catch {
    /* best-effort: the copy was approved, only the memo failed */
  }
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
      carryAskFlag: args.opts.carry === 'ask' ? true : undefined,
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
