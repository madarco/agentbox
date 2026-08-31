import { describe, expect, it } from 'vitest';
import { resolveAgentSpec } from '@agentbox/sandbox-core';
import { exampleSyncModule } from '../src/index.js';

/**
 * The demo agent is the repo's answer to "what does adding an agent cost?".
 *
 * These assertions are deliberately about the CONTRACT rather than about this
 * agent's quirks: whatever is asserted here is what a new agent must satisfy,
 * and everything it does NOT need is proof the contract stayed small.
 */
describe('the demo agent implements the whole contract', () => {
  it('is the agent its registry row describes', () => {
    const spec = resolveAgentSpec('example');
    expect(exampleSyncModule.id).toBe(spec.id);
    // Hidden, but real: absent from pickers, present to the machinery.
    expect(spec.hidden).toBe(true);
  });

  it('resolves the shared volume from the spec, never a second copy of the name', () => {
    const spec = resolveAgentSpec('example');
    expect(exampleSyncModule.resolveVolume({ isolate: false, boxId: 'demo1234' }).volume).toBe(
      spec.dockerVolume,
    );
  });

  it('gives an isolated box a volume of its own', () => {
    const shared = exampleSyncModule.resolveVolume({ isolate: false, boxId: 'demo1234' }).volume;
    const iso = exampleSyncModule.resolveVolume({ isolate: true, boxId: 'demo1234' }).volume;
    expect(iso).not.toBe(shared);
    expect(iso).toContain('demo1234');
  });

  it('mounts its config volume at the box dir the spec declares', () => {
    const spec = resolveAgentSpec('example');
    const choice = exampleSyncModule.resolveVolume({ isolate: false, boxId: 'demo1234' });
    const mounts = exampleSyncModule.buildMounts(choice, {});
    expect(mounts.volumeName).toBe(choice.volume);
    expect(mounts.extraVolumes).toEqual([`${choice.volume}:${spec.staticPaths[0]!.boxDir}`]);
  });

  it('needs neither optional hook', () => {
    // The point of them being optional. An agent with no post-sync step and no
    // expiring credential writes nothing, rather than stubbing two no-ops.
    expect(exampleSyncModule.afterVolumeSync).toBeUndefined();
    expect(exampleSyncModule.warmUpCredentials).toBeUndefined();
  });
});
