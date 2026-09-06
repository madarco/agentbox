import { describe, expect, it } from 'vitest';
import type { AgentSyncSpec } from '@agentbox/core';
import { resolveAgentIsolation } from '../src/agent-isolation.js';

/**
 * A service agent's config volume must be per-box by default — two gateways
 * sharing a state dir share one identity. Asserted on throwaway specs so the
 * rule is tested as a rule, not as a fact about whichever agents ship today.
 */
function spec(id: string, surface: 'tui' | 'service'): AgentSyncSpec {
  return { id, dockerVolume: `agentbox-${id}-config`, caps: { surface } } as AgentSyncSpec;
}

const SERVICE = spec('gateway', 'service');
const TUI = spec('claude', 'tui');

describe('resolveAgentIsolation', () => {
  it('isolates a service agent with no option passed', () => {
    expect(resolveAgentIsolation(SERVICE, {})).toBe(true);
  });

  it('leaves a TUI agent on the shared volume with no option passed', () => {
    expect(resolveAgentIsolation(TUI, {})).toBe(false);
  });

  it('honors the named per-agent options', () => {
    expect(resolveAgentIsolation(TUI, { claudeConfig: { isolate: true } })).toBe(true);
    expect(resolveAgentIsolation(spec('codex', 'tui'), { codexConfig: { isolate: true } })).toBe(
      true,
    );
    expect(
      resolveAgentIsolation(spec('opencode', 'tui'), { opencodeConfig: { isolate: true } }),
    ).toBe(true);
  });

  it('honors the generic map for an agent with no named option', () => {
    expect(
      resolveAgentIsolation(spec('pi', 'tui'), { agentConfig: { pi: { isolate: true } } }),
    ).toBe(true);
  });

  it('lets an explicit false override a service agent, but warns what it costs', () => {
    const lines: string[] = [];
    const isolate = resolveAgentIsolation(
      SERVICE,
      { agentConfig: { gateway: { isolate: false } } },
      (l) => lines.push(l),
    );
    expect(isolate).toBe(false);
    // The consequence, not the setting name.
    expect(lines.join('\n')).toMatch(/identity/);
  });

  it('does not warn when a TUI agent shares its volume', () => {
    const lines: string[] = [];
    resolveAgentIsolation(TUI, { agentConfig: { claude: { isolate: false } } }, (l) =>
      lines.push(l),
    );
    expect(lines).toEqual([]);
  });
});
