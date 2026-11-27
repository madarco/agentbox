import { loadEffectiveConfig } from '@agentbox/config';

/**
 * `box.carryVenv` for the project at `dir`: whether a host -> box workspace
 * move keeps the Python env dirs (`PYTHON_ENV_DIR_NAMES`).
 *
 * Read at the seed itself, not threaded from the CLI, for the reason
 * `autoApproveHostActions` is: every entrypoint that seeds a box (create, the
 * agent commands, the hub worker, upload, resync) then agrees without each one
 * carrying the flag. An unreadable config means the default, which is the safe
 * side: drop them.
 */
export async function resolveCarryVenv(dir: string): Promise<boolean> {
  try {
    return (await loadEffectiveConfig(dir)).effective.box.carryVenv === true;
  } catch {
    return false;
  }
}
