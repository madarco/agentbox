import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, KEY_REGISTRY, lookupKey } from '@agentbox/config';
import { AGENT_SYNC_SPECS } from '@agentbox/sandbox-core';

/**
 * `@agentbox/config`'s `AGENT_KINDS` is a COPY of what the agent registry knows,
 * because config has no internal dependencies — every package depends on it,
 * never the reverse — so it cannot import the registry to find out.
 *
 * That is the same arrangement `PROVIDERS` uses, and it drifts the same way. The
 * cross-check therefore lives here, in the one place that can reach both, which
 * is exactly why `provider-descriptors.test.ts` lives here too.
 *
 * If this fails after adding an agent: add its row to
 * `packages/config/src/agents.ts`. Its config keys are generated from that row.
 */
describe('config AGENT_KINDS vs the agent registry', () => {
  it('covers every registered agent, with the same id and session name', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      const kind = AGENT_KINDS.find((a) => a.id === spec.id);
      expect(kind, `config has no AGENT_KINDS row for '${spec.id}'`).toBeDefined();
      expect(kind!.defaultSessionName, spec.id).toBe(spec.sessionName);
    }
  });

  it('knows about no agent the registry does not', () => {
    const known = new Set(AGENT_SYNC_SPECS.map((s) => s.id));
    const extra = AGENT_KINDS.filter((a) => !known.has(a.id)).map((a) => a.id);
    expect(extra, 'config declares agents the registry has never heard of').toEqual([]);
  });

  it('generates a sessionName key for every agent', () => {
    for (const spec of AGENT_SYNC_SPECS) {
      expect(lookupKey(`${spec.id}.sessionName`), spec.id).toBeDefined();
    }
  });

  it('generates a skip-permissions key only where the agent has such a flag', () => {
    // OpenCode has none. Generating the key for every agent would create one
    // that silently does nothing, which is worse than its absence.
    for (const kind of AGENT_KINDS) {
      const key = lookupKey(`${kind.id}.dangerouslySkipPermissions`);
      expect(Boolean(key), `${kind.id}.dangerouslySkipPermissions`).toBe(kind.hasSkipPermissions);
    }
  });

  it('generates a per-box config-volume key for every TUI agent, and none for a service agent', () => {
    // These live under `box.` — they describe which volume the BOX mounts, not
    // how the agent launches — so they are generated separately from the
    // `<agent>.*` block and need their own check.
    //
    // A SERVICE agent gets none: its volume is always per-box (two daemons
    // sharing a state dir share one identity), so `create` derives isolation
    // from `caps.surface` and a key that could be set to `false` would be one
    // the product ignores.
    const service = AGENT_SYNC_SPECS.filter((s) => s.caps.surface === 'service');
    expect(service.length, 'the registry has no service agent left to check').toBeGreaterThan(0);
    for (const spec of AGENT_SYNC_SPECS) {
      const cap = spec.id.charAt(0).toUpperCase() + spec.id.slice(1);
      const key = lookupKey(`box.isolate${cap}Config`);
      expect(Boolean(key), `box.isolate${cap}Config`).toBe(spec.caps.surface !== 'service');
    }
  });

  it('AGENT_KINDS mirrors the registry surface', () => {
    // The one field config copies beyond the id and the session name, and the
    // only thing the isolate-key decision above reads.
    for (const spec of AGENT_SYNC_SPECS) {
      const kind = AGENT_KINDS.find((a) => a.id === spec.id) as { surface?: string } | undefined;
      expect(kind?.surface ?? 'tui', spec.id).toBe(spec.caps.surface ?? 'tui');
    }
  });

  it('gives every generated key a description', () => {
    // A key with no description is invisible in `agentbox config list`.
    const agentKeys = KEY_REGISTRY.filter((d) =>
      (AGENT_KINDS as readonly { id: string }[]).some(
        (a) =>
          d.key.startsWith(`${a.id}.`) ||
          d.key === `box.isolate${a.id.charAt(0).toUpperCase() + a.id.slice(1)}Config`,
      ),
    );
    expect(agentKeys.length).toBeGreaterThanOrEqual(AGENT_KINDS.length);
    for (const d of agentKeys) expect(d.description.length, d.key).toBeGreaterThan(0);
  });
});
