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
  await resyncCarryFiles({ box: args.box, projectRoot: args.projectRoot, onLog });
  return buildResyncWarning(result);
}
