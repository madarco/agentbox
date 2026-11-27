import { loadEffectiveConfig } from '@agentbox/config';

/**
 * `box.carryAll` for the project at `dir`: whether a host -> box workspace move
 * keeps the untracked generated dirs (`GENERATED_DIR_NAMES`) it otherwise drops.
 *
 * Read at the seed itself, not threaded from the CLI, for the reason
 * `autoApproveHostActions` is: every entrypoint that seeds a box (create, the
 * agent commands, the hub worker, upload, resync) then agrees without each one
 * carrying the flag. An unreadable config means the default, which is the safe
 * side: drop them.
 */
export async function resolveCarryAll(dir: string): Promise<boolean> {
  try {
    return (await loadEffectiveConfig(dir)).effective.box.carryAll === true;
  } catch {
    return false;
  }
}
