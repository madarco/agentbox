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
import {
  loadEffectiveConfig,
  readCarryGrant,
  removeCarryGrant,
  writeCarryGrant,
} from '@agentbox/config';
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
  /**
   * The raw `--carry <mode>` value, unvalidated. Parsed here rather than by each
   * caller so an unknown mode is REFUSED in one place: with no commander default
   * left, a typo would otherwise be indistinguishable from "no flag" and fall
   * into the granted-silent path — copying host secrets with no prompt.
   */
  carryMode?: string;
  onLog?: (line: string) => void;
}

/** `--carry <mode>`, or undefined for "no flag". Throws on anything else. */
export function parseCarryMode(raw: string | undefined): 'skip' | 'ask' | undefined {
  if (raw === undefined) return undefined;
  if (raw === 'skip' || raw === 'ask') return raw;
  throw new Error(`--carry: expected 'skip' or 'ask', got "${raw}"`);
}

/**
 * Resolve the three short-circuits from the flags and the environment.
 *
 * Pure so the precedence is testable without a box: `--carry ask` is a request
 * to BE asked, so it beats both env bypasses. Resolving it as `flag ?? env`
 * would let `AGENTBOX_CARRY=skip` silently win over an explicit flag and skip
 * the copy the user just asked to review — inverting CLI > env.
 */
export function resolveCarryFlags(args: {
  mode: 'skip' | 'ask' | undefined;
  carryYesFlag?: boolean;
  env?: { AGENTBOX_CARRY_YES?: string | undefined; AGENTBOX_CARRY?: string | undefined };
}): { carryYes: boolean; carrySkip: boolean; carryAsk: boolean } {
  const env = args.env ?? process.env;
  if (args.mode === 'ask') return { carryYes: false, carrySkip: false, carryAsk: true };
  return {
    carryYes: args.carryYesFlag ?? env.AGENTBOX_CARRY_YES === '1',
    carrySkip: args.mode === 'skip' || env.AGENTBOX_CARRY === 'skip',
    carryAsk: false,
  };
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
  const { carryYes, carrySkip, carryAsk } = resolveCarryFlags({
    mode: parseCarryMode(args.carryMode),
    ...(args.carryYesFlag !== undefined ? { carryYesFlag: args.carryYesFlag } : {}),
  });
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
    ...(carryAsk ? { carryAsk: true } : {}),
    ...(args.onLog ? { onLog: args.onLog } : {}),
  });

  // Store only a fresh HUMAN approval: `fromGrant` is already stored, and
  // `--carry-yes` is a one-shot bypass that must not leave a standing grant.
  if (result.decision === 'approve' && result.grantId && !result.fromGrant && !carryYes) {
    await recordGrant(args.projectRoot, result.grantId, result.entries);
  }
  // Someone was shown the table again and said no: withdraw the standing
  // approval rather than let the next plain create silently copy what they just
  // refused. Only a declined PROMPT revokes — a per-run `--carry skip` never
  // reaches a human, so it leaves the grant alone.
  if (result.decision !== 'approve' && result.asked && granted) {
    await removeCarryGrant(args.projectRoot).catch(() => {});
    args.onLog?.('carry: approval withdrawn for this project');
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
      carryMode: args.opts.carry,
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
