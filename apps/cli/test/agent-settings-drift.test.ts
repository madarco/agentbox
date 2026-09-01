import { describe, expect, it } from 'vitest';
import { AGENT_KINDS, type AgentConfigKind } from '@agentbox/config';
import { AGENT_SYNC_SPECS, findAgentSpec } from '@agentbox/sandbox-core';

/**
 * `AGENT_KINDS` mirrors the registry's declared settings, and cannot import it.
 *
 * `@agentbox/config` is a zero-internal-dep leaf — every package depends on it,
 * never the reverse — so it cannot read `AGENT_SYNC_SPECS` to learn what an
 * agent declares. The settings are copied there as data, exactly as the agent
 * ids and the provider table already are, and drift-tested from HERE because
 * `apps/cli` is the one place that can see both.
 *
 * Drift is silent in the direction that matters: a setting declared on the spec
 * but missing from the table generates no config key, so `agentbox config set
 * claude.install npm` fails with "unknown key" while the mechanism it drives
 * works perfectly.
 */
describe('AGENT_KINDS settings mirror the registry', () => {
  for (const kind of AGENT_KINDS as readonly AgentConfigKind[]) {
    it(`${kind.id} declares the same settings on both sides`, () => {
      const spec = findAgentSpec(kind.id);
      expect(spec, `${kind.id} is in AGENT_KINDS but not in the registry`).toBeDefined();
      const fromSpec = (spec?.settings ?? []).map((s) => ({
        key: s.key,
        type: s.type,
        enumValues: s.enumValues ? [...s.enumValues] : undefined,
        default: s.default,
        description: s.description,
        advanced: s.advanced,
      }));
      const fromConfig = (kind.settings ?? []).map((s) => ({
        key: s.key,
        type: s.type,
        enumValues: s.enumValues ? [...s.enumValues] : undefined,
        default: s.default,
        description: s.description,
        advanced: s.advanced,
      }));
      expect(fromConfig).toEqual(fromSpec);
    });
  }
});

/**
 * The two declarative bindings are the only things shared code does with a
 * setting on its own. Both name a setting explicitly rather than reserving a key
 * name, precisely so this check is possible.
 */
describe('every setting binding names a setting that exists', () => {
  for (const spec of AGENT_SYNC_SPECS) {
    const declared = (key: string) => spec.settings?.find((s) => s.key === key);

    it(`${spec.id}: install.alternatesFrom and alternates agree`, () => {
      const from = spec.install.alternatesFrom;
      const alternates = Object.keys(spec.install.alternates ?? {});
      // Both directions: an `alternates` map nothing selects is dead, and a
      // selector naming no map silently does nothing.
      expect(!!from, `${spec.id}: alternates and alternatesFrom must be declared together`).toBe(
        alternates.length > 0,
      );
      if (!from) return;
      const setting = declared(from);
      expect(setting, `${spec.id}.install.alternatesFrom names no declared setting`).toBeDefined();
      expect(setting?.type).toBe('enum');
      // Every alternate must be reachable, and the DEFAULT must not name one —
      // the default is the recipe on the row itself.
      expect(setting?.enumValues).toEqual(expect.arrayContaining(alternates));
      expect(alternates).not.toContain(setting?.default);
    });

    it(`${spec.id}: tuiEnvFrom and tuiEnv agree`, () => {
      const from = spec.tuiEnvFrom;
      expect(!!from, `${spec.id}: tuiEnv and tuiEnvFrom must be declared together`).toBe(
        !!spec.tuiEnv,
      );
      if (!from || !spec.tuiEnv) return;
      const setting = declared(from);
      expect(setting, `${spec.id}.tuiEnvFrom names no declared setting`).toBeDefined();
      expect(setting?.type).toBe('enum');
      // Every mode the setting accepts must have an entry, or picking it
      // silently leaves the previous renderer in place.
      expect(Object.keys(spec.tuiEnv).sort()).toEqual([...(setting?.enumValues ?? [])].sort());
    });

    it(`${spec.id}: every declared setting is well-formed`, () => {
      for (const s of spec.settings ?? []) {
        // A dotted leaf would generate `<agent>.a.b`, which the config parser
        // reads as a nested branch that nothing materialises.
        expect(s.key).not.toContain('.');
        expect(s.description.length).toBeGreaterThan(0);
        if (s.type === 'enum') {
          expect(s.enumValues?.length ?? 0).toBeGreaterThan(0);
          expect(s.enumValues).toContain(s.default);
        } else {
          expect(typeof s.default).toBe(s.type === 'bool' ? 'boolean' : 'string');
        }
      }
    });
  }
});
