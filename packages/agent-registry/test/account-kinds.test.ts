import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_SPECS } from '../src/index.js';
import { accountKindsProblem, agentSpecProblem } from '../src/plugin-agents.js';
import { exampleSpec } from '../src/specs/example.js';

describe('accountKinds on the built-in rows', () => {
  const kinds = (id: string) => BUILTIN_AGENT_SPECS.find((s) => s.id === id)?.accountKinds;

  it('claude and codex declare their account kinds', () => {
    expect(kinds('claude')).toEqual(['login', 'setup-token', 'api-key']);
    expect(kinds('codex')).toEqual(['login', 'api-key']);
  });

  it('every built-in row passes the same check a plugin row gets', () => {
    for (const spec of BUILTIN_AGENT_SPECS) {
      if (spec.accountKinds === undefined) continue;
      expect(
        accountKindsProblem(spec.accountKinds, spec.credential !== undefined),
        spec.id,
      ).toBeNull();
    }
  });
});

describe('accountKindsProblem', () => {
  it('refuses unknown, duplicate and non-array kinds', () => {
    expect(accountKindsProblem('login', true)).toMatch(/must be an array/);
    expect(accountKindsProblem(['password'], true)).toMatch(/must be one of/);
    expect(accountKindsProblem(['api-key', 'api-key'], true)).toMatch(/twice/);
  });

  it('refuses login on an agent with no credential, allows a key-only agent', () => {
    expect(accountKindsProblem(['login'], false)).toMatch(/no `credential`/);
    expect(accountKindsProblem(['api-key'], false)).toBeNull();
    expect(accountKindsProblem([], false)).toBeNull();
  });

  it('agentSpecProblem applies it to plugin specs', () => {
    expect(agentSpecProblem({ ...exampleSpec, accountKinds: ['login', 'api-key'] })).toBeNull();
    expect(agentSpecProblem({ ...exampleSpec, accountKinds: ['oauth'] })).toMatch(/accountKinds/);
    const { credential: _c, ...noCredential } = exampleSpec;
    expect(agentSpecProblem({ ...noCredential, accountKinds: ['login'] })).toMatch(
      /no `credential`/,
    );
  });
});
