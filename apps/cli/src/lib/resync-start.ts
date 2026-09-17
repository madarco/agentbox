import { log } from '@clack/prompts';
import type { BoxRecord } from '@agentbox/core';
import { providerForBox } from '../provider/registry.js';
import { resyncCarryFiles } from './carry-resync.js';
import { buildResyncWarning } from './resync-warning.js';

/**
 * On an agent-session start, resync the box's workspace with the host (git
 * merge + carry-file refresh) and return the conflict warning to inject into
 * the agent's prompt (or null when nothing conflicted / resync is off).
 *
 * Routed through `provider.resyncWorkspace` — providers that can't reach a live
 * host workspace omit it and resync is skipped for that box (docker implements
 * it; cloud until Phase 7.5 does not). The caller is responsible for gating on
 * the down→up transition so we never mutate files under a live agent.
 */
export async function maybeResyncWorkspace(args: {
  box: BoxRecord;
  enabled: boolean;
  projectRoot: string;
  spinner?: { message: (s: string) => void };
}): Promise<string | null> {
  if (!args.enabled) return null;
  const provider = await providerForBox(args.box);
  if (!provider.resyncWorkspace) return null;
  const onLog = (line: string): void => args.spinner?.message(line);
  args.spinner?.message('resyncing workspace with host');
  const result = await provider.resyncWorkspace(args.box, onLog);
  // Carry-file resync is docker-specific (re-copies via docker exec); cloud boxes
  // get workspace resync only. Gate so a cloud box with approved carry entries
  // doesn't hit docker's copyCarryPathsToBox.
  if ((args.box.provider ?? 'docker') === 'docker') {
    const carry = await resyncCarryFiles({
      box: args.box,
      projectRoot: args.projectRoot,
      onLog,
    });
    // A start is not failed over a stale carry file — the box is already up and
    // the agent is about to run — but the miss has to be SEEN. `onLog` only
    // repaints the spinner, so these would otherwise vanish the moment the next
    // line landed.
    for (const failure of carry.failures) log.warn(`carry: ${failure}`);
  }
  return buildResyncWarning(result);
}
