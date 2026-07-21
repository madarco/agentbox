import type { BoxRecord, SyncTransport } from '@agentbox/core';
import { providerForBox } from '../provider/registry.js';
import { log } from '../lib/prompt.js';

/**
 * Resolve the `SyncTransport` for a cloud box's settings pull, resuming the
 * box first when needed (a cloud pull reads the live box FS — unlike docker,
 * where `download <agent>` reads the config volume and works while stopped).
 * The pull mechanics themselves live in the sync layer
 * (`@agentbox/sandbox-core` `agent-pull.ts`); this is CLI lifecycle glue only.
 */
export async function cloudTransportForPull(box: BoxRecord): Promise<SyncTransport> {
  const provider = await providerForBox(box);
  if (!provider.syncTransport) {
    throw new Error(
      `provider '${box.provider ?? 'unknown'}' does not support settings download from a live box`,
    );
  }
  const insp = await provider.inspect(box);
  if (insp.state !== 'running') {
    if (insp.state === 'missing') {
      throw new Error(`box ${box.name} no longer exists; was it destroyed?`);
    }
    log.info(`box is ${insp.state}; resuming`);
    await provider.resume(box);
  }
  return provider.syncTransport(box);
}
