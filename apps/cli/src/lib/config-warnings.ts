import { log } from '@clack/prompts';
import { setConfigWarningSink } from '@agentbox/config';

/**
 * Print non-fatal config warnings (unknown keys) once per process.
 *
 * `loadEffectiveConfig` runs many times in a single command, and each run
 * re-parses the same files — without de-duplication a stray key would print a
 * dozen times. The set is process-scoped, so the user sees each distinct issue
 * exactly once no matter how many times config is loaded.
 */
const seen = new Set<string>();

export function installConfigWarningSink(): void {
  setConfigWarningSink((message) => {
    if (seen.has(message)) return;
    seen.add(message);
    log.warn(message);
  });
}
