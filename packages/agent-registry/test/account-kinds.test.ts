import { describe, expect, it } from 'vitest';
import { BUILTIN_AGENT_SPECS } from '../src/index.js';
import {
  accountEnvProblem,
  accountKindsProblem,
  agentSpecProblem,
  llmHostsProblem,
} from '../src/plugin-agents.js';
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
    expect(
      agentSpecProblem({
        ...exampleSpec,
        accountKinds: ['login', 'api-key'],
        accountEnv: { 'api-key': 'EXAMPLE_API_KEY' },
      }),
    ).toBeNull();
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

describe('accountEnvProblem (Phase 3)', () => {
  it('every built-in row passes', () => {
    for (const spec of BUILTIN_AGENT_SPECS) {
      expect(accountEnvProblem(spec.accountEnv, spec.accountKinds), spec.id).toBeNull();
    }
  });
  it('requires an env var for each pasted kind, and only for those', () => {
    expect(accountEnvProblem(undefined, ['login'])).toBeNull();
    expect(accountEnvProblem(undefined, ['login', 'api-key'])).toMatch(/'api-key'/);
    expect(accountEnvProblem({ 'api-key': 'MY_KEY' }, ['api-key'])).toBeNull();
    expect(accountEnvProblem({ login: 'X' }, ['login'])).toMatch(/not a pasted kind/);
    expect(accountEnvProblem({ 'api-key': 'my-key' }, ['api-key'])).toMatch(/UPPER_SNAKE/);
    expect(accountEnvProblem({}, ['setup-token'])).toMatch(/'setup-token'/);
  });
});

describe('llmHostsProblem (Phase 7)', () => {
  it('every built-in row passes, and claude/codex declare their model hosts', () => {
    for (const spec of BUILTIN_AGENT_SPECS) {
      if (spec.llmHosts) expect(llmHostsProblem(spec.llmHosts), spec.id).toBeNull();
    }
    const byId = new Map(BUILTIN_AGENT_SPECS.map((s) => [s.id, s]));
    expect(byId.get('claude')?.llmHosts).toContain('api.anthropic.com');
    expect(byId.get('codex')?.llmHosts).toContain('chatgpt.com');
  });
  it('refuses wildcards, ports, schemes and uppercase: the hub allowlist is built from these', () => {
    expect(llmHostsProblem(['api.example.com'])).toBeNull();
    for (const bad of [
      '*.example.com',
      'api.example.com:443',
      'https://api.example.com',
      'API.example.com',
      'localhost',
      '',
    ]) {
      expect(llmHostsProblem([bad]), bad).toMatch(/llmHosts/);
    }
    expect(llmHostsProblem('api.example.com')).toMatch(/array/);
    expect(agentSpecProblem({ ...exampleSpec, llmHosts: ['*.evil.com'] })).toMatch(/llmHosts/);
  });
});
