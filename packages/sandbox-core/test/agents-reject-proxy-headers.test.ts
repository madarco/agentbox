import { describe, expect, it } from 'vitest';
import { AGENT_SYNC_SPECS, agentsRejectProxyHeaders } from '../src/index.js';

/**
 * Which agents force a box to publish its port directly.
 *
 * The answer comes off the registry, never off an id, and the INPUT is the
 * agents a box was created FOR. `lastAgent` would be wrong: it is whichever
 * agent most recently ran, is written after `create` returns, and a later
 * `agentbox claude` in an openclaw box overwrites it — none of which stops the
 * box hosting a gateway that 403s proxied requests.
 */
describe('agentsRejectProxyHeaders', () => {
  it('is true for an agent whose row declares it', () => {
    const declaring = AGENT_SYNC_SPECS.filter((s) => s.service?.rejectsProxyHeaders === true);
    expect(declaring.length).toBeGreaterThan(0);
    for (const spec of declaring) {
      expect(agentsRejectProxyHeaders([spec.id])).toBe(true);
    }
  });

  it('is false for every agent that does not', () => {
    for (const spec of AGENT_SYNC_SPECS.filter((s) => s.service?.rejectsProxyHeaders !== true)) {
      expect(agentsRejectProxyHeaders([spec.id])).toBe(false);
    }
  });

  it('resolves aliases, not just canonical ids', () => {
    // Box records and queue jobs carry the wire spelling.
    expect(agentsRejectProxyHeaders(['claude-code'])).toBe(false);
  });

  it('is true when any one agent in the list declares it', () => {
    expect(agentsRejectProxyHeaders(['claude', 'openclaw'])).toBe(true);
  });

  it('does not match an id this build has never heard of', () => {
    // The registry is open (`agentbox agent add`). An unknown name must not
    // cost a box its friendly URL.
    expect(agentsRejectProxyHeaders(['definitely-not-an-agent'])).toBe(false);
  });

  it('is false for a box created with no agents at all', () => {
    expect(agentsRejectProxyHeaders([])).toBe(false);
    expect(agentsRejectProxyHeaders(undefined)).toBe(false);
  });
});
