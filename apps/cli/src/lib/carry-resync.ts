import { join } from 'node:path';
import { loadEffectiveConfig } from '@agentbox/config';
import { loadCarrySection } from '@agentbox/ctl';
import {
  carrySourceHash,
  copyCarryPathsToBox,
  recordBox,
  type BoxRecord,
} from '@agentbox/sandbox-docker';
import { resolveCarry } from './carry-resolve.js';

export interface ResyncCarryResult {
  /** Approved carry entries whose host source changed and were re-copied. */
  recopied: number;
  /** Carry declarations not previously approved — skipped (need a fresh create to approve). */
  skippedNew: number;
}

/**
 * Re-copy `carry:` files whose host source changed since the box was created.
 * One-way (host wins) and within the original grant: only entries already in
 * `box.carry.entries` (approved at create) are re-copied — so no re-prompt is
 * needed, safe for background/`-i`. New declarations are skipped and logged
 * (they require the create-time gate). Docker-only.
 *
 * Persists the refreshed hashes onto the box record so the next start only
 * re-copies what changed again.
 */
export async function resyncCarryFiles(args: {
  box: BoxRecord;
  projectRoot: string;
  onLog?: (line: string) => void;
}): Promise<ResyncCarryResult> {
  const log = args.onLog ?? (() => {});
  const prior = args.box.carry?.entries ?? [];
  if (prior.length === 0) return { recopied: 0, skippedNew: 0 };

  const items = await loadCarrySection(join(args.projectRoot, 'agentbox.yaml'));
  if (items.length === 0) return { recopied: 0, skippedNew: 0 };

  // Resolve (incl. safety checks). On a hard resolver error we skip resync
  // rather than block the box start — the create-time gate is the gating point.
  const cfg = await loadEffectiveConfig(args.projectRoot);
  const resolved = await resolveCarry(items, {
    projectRoot: args.projectRoot,
    maxBytes: cfg.effective.box.cpMaxBytes,
  });
  if (resolved.errors.length > 0) {
    log(`carry: resync skipped (resolve errors: ${resolved.errors.length})`);
    return { recopied: 0, skippedNew: 0 };
  }

  const priorByDest = new Map(prior.map((e) => [e.dest, e]));
  const changed: typeof resolved.entries = [];
  let skippedNew = 0;
  for (const entry of resolved.entries) {
    if (entry.kind === 'missing') continue;
    const existing = priorByDest.get(entry.absDest);
    if (!existing) {
      skippedNew += 1;
      continue;
    }
    const hash = await carrySourceHash(entry);
    if (hash === undefined || hash !== existing.hash) changed.push(entry);
  }

  if (skippedNew > 0) {
    log(
      `carry: ${String(skippedNew)} new entry/entries not applied on resync — recreate the box to approve`,
    );
  }
  if (changed.length === 0) return { recopied: 0, skippedNew };

  const result = await copyCarryPathsToBox({
    container: args.box.container,
    entries: changed,
    onLog: log,
  });
  for (const err of result.errors) log(`carry: ${err}`);

  // Merge the re-copied entries' fresh bytes+hash back into the audit summary.
  const updatedByDest = new Map(result.applied.map((e) => [e.dest, e]));
  const mergedEntries = prior.map((e) => updatedByDest.get(e.dest) ?? e);
  await recordBox({
    ...args.box,
    carry: { count: mergedEntries.length, entries: mergedEntries },
  });

  if (result.applied.length > 0) {
    log(`carry: re-copied ${String(result.applied.length)} changed file(s)`);
  }
  return { recopied: result.applied.length, skippedNew };
}
