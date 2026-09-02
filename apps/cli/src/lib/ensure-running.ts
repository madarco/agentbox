import { log } from '@agentbox/cli-kit';
import type { BoxRecord, Provider } from '@agentbox/core';

/**
 * Bring a box up so a file operation can reach it, whatever provider it is on.
 *
 * `agentbox sync` / `download` / `clone` all need a live box for one exec and
 * one tar hop, and the docker-only `ensureBoxRunning` in `shell.ts` can't serve
 * them. Driven through the provider seam so a paused cloud sandbox resumes the
 * same way a paused container unpauses. Returns the (possibly re-resolved)
 * record — `start` re-allocates ephemeral host ports and hands back a fresh one.
 */
export async function ensureBoxRunningVia(provider: Provider, box: BoxRecord): Promise<BoxRecord> {
  const state = await provider.probeState(box);
  if (state === 'running') return box;
  if (state === 'missing') {
    throw new Error(`box ${box.name} no longer exists; was it destroyed?`);
  }
  if (state === 'paused') {
    log.info('box is paused; resuming');
    await provider.resume(box);
    return box;
  }
  log.info('box is stopped; starting');
  return await provider.start(box);
}
