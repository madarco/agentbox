import { beforeEach, describe, expect, it } from 'vitest';
import {
  agentSyncModule,
  registerAgentSyncModule,
  registeredAgentSyncModules,
  requireAgentSyncModule,
  type AgentSyncModule,
} from '../src/sync/agents/module.js';

/**
 * The registry contract, tested with stubs rather than the shipped agents.
 *
 * That is not a weakening — it is the point. No agent lives in this package any
 * more, and it cannot import one (an agent depends on it, so importing back is
 * the cycle). What this package owns is the CONTRACT; whether the real agents
 * satisfy it is asserted in `@agentbox/agent-modules`, which can see them all.
 */

function stub(id: string, extra: Partial<AgentSyncModule> = {}): AgentSyncModule {
  return {
    id,
    resolveVolume: ({ isolate, boxId }) => ({
      volume: isolate ? `agentbox-${id}-${boxId}` : `agentbox-${id}-config`,
    }),
    buildMounts: (spec) => ({
      extraVolumes: [`${spec.volume}:/home/vscode/.${id}`],
      env: {},
      volumeName: spec.volume,
    }),
    ensureVolume: () => Promise.resolve({ created: false, synced: false }),
    sessionInfo: () => Promise.resolve({ running: false, sessionName: id, startedAt: null }),
    ...extra,
  };
}

describe('agent sync module registry', () => {
  beforeEach(() => {
    registerAgentSyncModule(stub('alpha'));
    registerAgentSyncModule(
      stub('beta', { afterVolumeSync: () => Promise.resolve({ notes: ['did a thing'] }) }),
    );
  });

  it('hands back what was registered', () => {
    expect(registeredAgentSyncModules().map((m) => m.id)).toEqual(
      expect.arrayContaining(['alpha', 'beta']),
    );
  });

  it('gives an isolated box its own volume, never the shared one', () => {
    const mod = requireAgentSyncModule('alpha');
    const shared = mod.resolveVolume({ isolate: false, boxId: 'aabbccdd' }).volume;
    const isolated = mod.resolveVolume({ isolate: true, boxId: 'aabbccdd' }).volume;
    expect(isolated).not.toBe(shared);
    expect(isolated).toContain('aabbccdd');
  });

  it('builds mounts that name the volume it resolved', () => {
    const mod = requireAgentSyncModule('alpha');
    const choice = mod.resolveVolume({ isolate: false, boxId: 'aabbccdd' });
    expect(mod.buildMounts(choice, {}).volumeName).toBe(choice.volume);
  });

  it('leaves the optional hooks absent for an agent that declares none', () => {
    // An agent needing neither a post-sync step nor a renewable credential
    // stubs nothing — which is why both are optional rather than no-op methods.
    expect(agentSyncModule('alpha')?.afterVolumeSync).toBeUndefined();
    expect(agentSyncModule('beta')?.afterVolumeSync).toBeTypeOf('function');
    expect(agentSyncModule('alpha')?.warmUpCredentials).toBeUndefined();
  });

  it('answers undefined for an unregistered agent, and throws only when asked to', () => {
    // A box may name an agent this build has no docker behavior for — a listing
    // must degrade, not crash. `require` is for call sites that cannot go on.
    expect(agentSyncModule('nobody')).toBeUndefined();
    expect(() => requireAgentSyncModule('nobody')).toThrow(/no docker sync module/);
  });
});
