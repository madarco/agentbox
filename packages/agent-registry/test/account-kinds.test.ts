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

  it('validates credential.boxRelPath, the field custody keys by (review #5)', () => {
    const withRel = (boxRelPath: string) =>
      agentSpecProblem({ ...exampleSpec, credential: { ...exampleSpec.credential!, boxRelPath } });
    expect(withRel('auth.json')).toBeNull();
    expect(withRel('sub/auth.json')).toBeNull();
    expect(withRel('accounts/work')).toMatch(/reserved for named accounts/);
    expect(withRel('accounts')).toMatch(/reserved for named accounts/);
    for (const bad of ['', '/abs/auth.json', '../auth.json', 'a/../b', 'a//b', './auth.json']) {
      expect(withRel(bad), bad).toMatch(/relative path/);
    }
  });

  it('refuses a path-unsafe agent id (review #6)', () => {
    expect(agentSpecProblem({ ...exampleSpec, id: '../../x' })).toMatch(/agent id/);
    expect(agentSpecProblem({ ...exampleSpec, id: 'My Agent' })).toMatch(/agent id/);
  });

  it('refuses the account infix in dockerVolume and cloudSubpath (review #8)', () => {
    expect(agentSpecProblem({ ...exampleSpec, dockerVolume: 'agentbox-x-acct-y' })).toMatch(
      /dockerVolume/,
    );
    const credential = { ...exampleSpec.credential!, cloudSubpath: 'claude-acct-work/' };
    expect(agentSpecProblem({ ...exampleSpec, credential })).toMatch(/cloudSubpath/);
  });
});
