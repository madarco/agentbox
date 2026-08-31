import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import {
  agentSyncModule,
  registeredAgentSyncModules,
  requireAgentSyncModule,
} from '../src/sync/agents/module.js';
import '../src/sync/agents/builtins.js';

/**
 * The registry is what lets this package stop importing agents by name.
 *
 * Importing `builtins.js` above is what a consumer does today; when an agent
 * becomes its own package the app registers it instead, and these assertions
 * hold unchanged. That is the point of testing the registry rather than the
 * adapters.
 */
describe('agent sync module registry', () => {
  it('has the shipped agents registered', () => {
    const ids = registeredAgentSyncModules().map((m) => m.id);
    expect(ids).toEqual(['claude', 'codex', 'opencode']);
  });

  it('resolves a volume through the module, matching the registry name', () => {
    // Not isolated -> the agent's SHARED volume, which is `spec.dockerVolume`.
    for (const spec of AGENT_SYNC_SPECS) {
      const mod = agentSyncModule(spec.id);
      if (!mod) continue;
      expect(mod.resolveVolume({ isolate: false, boxId: 'aabbccdd' }).volume).toBe(
        spec.dockerVolume,
      );
    }
  });

  it('gives an isolated box its own volume, never the shared one', () => {
    for (const mod of registeredAgentSyncModules()) {
      const shared = mod.resolveVolume({ isolate: false, boxId: 'aabbccdd' }).volume;
      const isolated = mod.resolveVolume({ isolate: true, boxId: 'aabbccdd' }).volume;
      expect(isolated).not.toBe(shared);
      expect(isolated).toContain('aabbccdd');
    }
  });

  it('builds mounts that name the volume it resolved', () => {
    for (const mod of registeredAgentSyncModules()) {
      const choice = mod.resolveVolume({ isolate: false, boxId: 'aabbccdd' });
      const mounts = mod.buildMounts(choice, {});
      expect(mounts.volumeName).toBe(choice.volume);
      expect(mounts.extraVolumes.some((v) => v.startsWith(`${choice.volume}:`))).toBe(true);
    }
  });

  it('declares the optional hooks only where the agent has one', () => {
    // codex folds AGENTS.override.md after the sync; claude warms a credential
    // that expires on its own. Neither is universal, which is why both are
    // optional rather than no-op methods on every agent.
    expect(agentSyncModule('codex')?.afterVolumeSync).toBeTypeOf('function');
    expect(agentSyncModule('opencode')?.afterVolumeSync).toBeUndefined();
    expect(agentSyncModule('claude')?.warmUpCredentials).toBeTypeOf('function');
    expect(agentSyncModule('codex')?.warmUpCredentials).toBeUndefined();
  });

  it('answers undefined for an unregistered agent, and throws only when asked to', () => {
    // A box may name an agent this build has no docker behavior for — a listing
    // must degrade, not crash. `require` is for the call sites that cannot go on.
    expect(agentSyncModule('example')).toBeUndefined();
    expect(() => requireAgentSyncModule('example')).toThrow(/no docker sync module/);
  });
});
