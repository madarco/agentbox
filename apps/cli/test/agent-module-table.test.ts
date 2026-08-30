import { agentIds, resolveAgentSpec } from '@agentbox/sandbox-core';
import { describe, expect, it } from 'vitest';
import { agentModuleIds, loadAgentModule } from '../src/agents/index.js';

/**
 * The exhaustiveness `Record<AgentId, …>` used to give for free.
 *
 * `AgentId` is an open string, so nothing makes the CLI's per-agent tables cover
 * the registry — a new agent would simply have no module, no login detector and
 * no `fork` command, and would fail at run time with whatever error the first
 * `undefined` produced. These assertions are the replacement.
 */
describe('agent module table', () => {
  it('covers exactly the registry, no more and no less', () => {
    expect([...agentModuleIds()].sort()).toEqual([...agentIds()].sort());
  });

  it('every module carries the registry row by reference, not a copy', async () => {
    for (const id of agentIds()) {
      const mod = await loadAgentModule(id);
      expect(mod.id).toBe(id);
      // Identity, not deep-equality: a copy could drift from the registry while
      // still comparing equal today.
      expect(mod.spec).toBe(resolveAgentSpec(id));
    }
  });

  it('login detectors are wired to the agent they claim', async () => {
    for (const id of agentIds()) {
      const mod = await loadAgentModule(id);
      expect(mod.login.agent).toBe(id);
    }
  });

  it('teleport resolver presence matches the declared capability', async () => {
    for (const id of agentIds()) {
      const mod = await loadAgentModule(id);
      const declared = resolveAgentSpec(id).caps.teleport;
      expect(typeof mod.teleport === 'function', `${id} declares teleport '${declared}'`).toBe(
        declared === 'full',
      );
    }
  });

  it('names the agent when a module is missing', async () => {
    await expect(loadAgentModule('nosuchagent')).rejects.toThrow(
      /no agent module for 'nosuchagent'/,
    );
  });
});
