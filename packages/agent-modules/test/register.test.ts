import { describe, expect, it } from 'vitest';
import { AGENT_SPECS } from '@agentbox/agent-registry';
import { registeredAgentSyncModules } from '@agentbox/sandbox-docker';
import { registerAllAgentModules } from '../src/index.js';

/**
 * This package is the only place that can see EVERY agent at once.
 *
 * `sandbox-docker` cannot: an agent package depends on it, so importing one back
 * is the cycle. Its own test therefore asserts only the agents still living
 * inside it. The whole-fleet assertion belongs here, where the wiring is.
 *
 * If a create ever dies on `requireAgentSyncModule`, this is the test that
 * should have caught it.
 */
describe('registerAllAgentModules', () => {
  it('registers a docker module for every agent that ships one', () => {
    registerAllAgentModules();
    const registered = new Set(registeredAgentSyncModules().map((m) => m.id));

    // EVERY agent, hidden or not. The canary is no longer exempt: it has a
    // package like the rest, which is the claim this whole phase makes.
    const missing = AGENT_SPECS.filter((s) => !registered.has(s.id)).map((s) => s.id);
    expect(missing, 'agents with no registered docker module').toEqual([]);
  });

  it('is idempotent — an app and an embedded hub may both call it', () => {
    registerAllAgentModules();
    const first = registeredAgentSyncModules().length;
    registerAllAgentModules();
    expect(registeredAgentSyncModules()).toHaveLength(first);
  });
});
