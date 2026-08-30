import { describe, expect, it } from 'vitest';
import type { BoxRecord, Provider, SyncTransport } from '@agentbox/core';
import { AGENT_SEED_MARKER, agentSeedPlacements } from '@agentbox/sandbox-core';
import { seedDeclaredFilesForLaunch } from '../src/sync/agent-seed.js';

/**
 * The shared launch-path seeder. Driven through the REAL seeder against a fake
 * transport rather than a mocked one, so the script it builds is exercised too.
 *
 * Its ORDERING contract (box must be running first) is asserted where the
 * ordering lives — `detached-agent.test.ts`.
 */
const box = { name: 'kanban', cloud: { sandboxId: 'sbx-1' } } as BoxRecord;

/** A transport that reports every one of `agent`'s declared seeds as placed. */
function fakeTransport(
  agent: string,
  opts: { onExec?: () => void; throws?: boolean } = {},
): SyncTransport {
  const markers = agentSeedPlacements(agent)
    .map((p) => `${AGENT_SEED_MARKER} ${p.destRel}`)
    .join('\n');
  return {
    exec: () => {
      opts.onExec?.();
      if (opts.throws) throw new Error('sandbox unreachable');
      return Promise.resolve({ exitCode: 0, stdout: markers, stderr: '' });
    },
    pushFile: () => Promise.resolve(),
  } as unknown as SyncTransport;
}

describe('seedDeclaredFilesForLaunch', () => {
  it('seeds through the provider transport', async () => {
    let execs = 0;
    const provider = {
      syncTransport: () => fakeTransport('opencode', { onExec: () => execs++ }),
    } as unknown as Provider;
    await seedDeclaredFilesForLaunch(provider, box, 'opencode');
    expect(execs).toBe(1);
  });

  it('is a no-op when the provider exposes no transport', async () => {
    const provider = { name: 'x' } as unknown as Provider;
    await expect(seedDeclaredFilesForLaunch(provider, box, 'opencode')).resolves.toBeUndefined();
  });

  it('swallows a seed failure rather than blocking the launch', async () => {
    const provider = {
      syncTransport: () => fakeTransport('codex', { throws: true }),
    } as unknown as Provider;
    await expect(seedDeclaredFilesForLaunch(provider, box, 'codex')).resolves.toBeUndefined();
  });
});
