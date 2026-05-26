import { join } from 'node:path';
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
  const log = args.onLog ?? (() => {});
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
    log(`carry: skipped for this box (${String(resolved.entries.length)} entry/entries not copied)`);
    return { decision: 'skip', entries: [] };
  }
  return { decision: 'approve', entries: resolved.entries };
}
