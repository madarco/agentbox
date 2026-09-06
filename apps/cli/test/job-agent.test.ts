import { describe, expect, it } from 'vitest';
import { planJobAgent } from '../src/lib/queue/job-agent.js';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';
import { isServiceAgent } from '@agentbox/core';

/**
 * What a queued create job's agent means for the worker.
 *
 * The bug this pins: the worker resolved the job's agent with `toSyncKind`,
 * which validates against the four agents compiled into `@agentbox/core` — so
 * `POST /api/v1/boxes` with a SERVICE agent (or any plugin agent) was accepted
 * by the hub route, which validates against the live registry, and then died in
 * the worker with `unknown agent kind`. The resolution has to come off the same
 * registry the route already checked.
 */
describe('planJobAgent', () => {
  it('translates the wire spelling to the canonical id', () => {
    const plan = planJobAgent({ agent: 'claude-code' });
    expect(plan.spec?.id).toBe('claude');
    expect(plan.agents).toEqual(['claude']);
    expect(plan.startsSession).toBe(true);
  });

  it('resolves an agent outside the four built-ins', () => {
    // The whole bug: `toSyncKind('openclaw')` threw here.
    const plan = planJobAgent({ agent: 'openclaw' });
    expect(plan.spec?.id).toBe('openclaw');
    expect(plan.agents).toEqual(['openclaw']);
  });

  it('gives a SERVICE agent a box but no session', () => {
    const service = AGENT_SYNC_SPECS.filter(isServiceAgent);
    expect(service.length).toBeGreaterThan(0);
    for (const spec of service) {
      const plan = planJobAgent({ agent: spec.id });
      // The third case: `agents:` names it (unlike noAgent) and nothing is
      // launched (unlike a TUI agent) — ctl synthesizes the units in-box.
      expect(plan.agents).toEqual([spec.id]);
      expect(plan.startsSession).toBe(false);
    }
  });

  it('still dispatches a session for every TUI agent', () => {
    const tui = AGENT_SYNC_SPECS.filter((s) => !isServiceAgent(s));
    expect(tui.length).toBeGreaterThan(0);
    for (const spec of tui) {
      expect(planJobAgent({ agent: spec.id }).startsSession).toBe(true);
    }
  });

  it('selects no agent, and no session, for a noAgent job', () => {
    // `agent` is still a valid placeholder on such a job; noAgent wins.
    const plan = planJobAgent({ noAgent: true, agent: 'claude-code' });
    expect(plan.spec).toBeUndefined();
    expect(plan.agents).toEqual([]);
    expect(plan.startsSession).toBe(false);
  });

  it('stays fail-closed on an agent the registry does not know', () => {
    expect(() => planJobAgent({ agent: 'gemini' })).toThrow(/no agent sync spec/);
  });
});
