import { beforeEach, describe, expect, it } from 'vitest';
import type { ToolGrant } from '@agentbox/config';
import { _resetHostBinReadyCacheForTests, assertHostBinReady } from '../src/host-exec.js';
import {
  argvIsExplicitlyAllowed,
  refuseCredentialArgv,
  refuseDeniedArgv,
  renderToolList,
  renderToolListJson,
  resolveToolGrant,
  toolRequestsEnabled,
} from '../src/host-tools.js';

function grant(over: Partial<ToolGrant> = {}): ToolGrant {
  return { name: 'terraform', bin: 'terraform', source: 'cli', ...over };
}

describe('built-in credential deny list', () => {
  // These are the shapes that would print a host credential into the box.
  // The old linear connector hard-rejected `auth token` in bespoke bash; this
  // is the generic replacement, so the linear case must still be covered.
  it.each([
    ['linear', ['auth', 'token']],
    ['gh', ['auth', 'token']],
    ['aws', ['configure', 'get', 'aws_secret_access_key']],
    ['gcloud', ['auth', 'print-access-token']],
    ['gcloud', ['auth', 'print-identity-token']],
    ['aws', ['ecr', 'get-token']],
    ['vault', ['secrets', 'get', 'db/creds']],
    ['op', ['item', 'get', 'x', '--show-secret']],
  ])('refuses %s %s', (name, args) => {
    const refusal = refuseCredentialArgv(name, args);
    expect(refusal?.exitCode).toBe(65);
    expect(refusal?.stderr).toContain('prints a host credential');
  });

  it('is case-insensitive (a CLI accepting AUTH TOKEN is still refused)', () => {
    expect(refuseCredentialArgv('linear', ['AUTH', 'TOKEN'])).not.toBeNull();
  });

  it('lets ordinary argv through', () => {
    expect(refuseCredentialArgv('terraform', ['plan'])).toBeNull();
    expect(refuseCredentialArgv('linear', ['issue', 'list'])).toBeNull();
    // `whoami` is the identity op the old connector allowed — still fine.
    expect(refuseCredentialArgv('linear', ['auth', 'whoami'])).toBeNull();
  });
});

describe('per-tool deny rules', () => {
  it('refuses argv matching a deny pattern', () => {
    const refusal = refuseDeniedArgv(grant({ deny: ['^destroy'] }), ['destroy', '-auto-approve']);
    expect(refusal?.exitCode).toBe(65);
    expect(refusal?.stderr).toContain('deny rule');
  });

  it('passes argv that matches nothing', () => {
    expect(refuseDeniedArgv(grant({ deny: ['^destroy'] }), ['plan'])).toBeNull();
  });

  it('fails loud (exit 78) on an invalid pattern rather than silently not denying', () => {
    const refusal = refuseDeniedArgv(grant({ deny: ['([unclosed'] }), ['plan']);
    expect(refusal?.exitCode).toBe(78);
  });

  it('no deny rules is a pass', () => {
    expect(refuseDeniedArgv(grant(), ['anything'])).toBeNull();
  });
});

describe('allow rules', () => {
  it('matches an allow pattern', () => {
    expect(argvIsExplicitlyAllowed(grant({ allow: ['^plan$', '^validate'] }), ['plan'])).toBe(true);
  });

  it('does not match a different subcommand', () => {
    expect(argvIsExplicitlyAllowed(grant({ allow: ['^plan$'] }), ['apply'])).toBe(false);
  });

  it('an invalid allow pattern never matches (fails closed to prompting)', () => {
    expect(argvIsExplicitlyAllowed(grant({ allow: ['([bad'] }), ['plan'])).toBe(false);
  });
});

describe('grant resolution', () => {
  const loader = (grants: ToolGrant[]) => async () =>
    new Map(grants.map((g) => [g.name, g] as const));

  it('refuses an ungranted tool with a hint for both surfaces', async () => {
    const r = await resolveToolGrant('terraform', '/repo', loader([]));
    expect('refusal' in r && r.refusal.exitCode).toBe(65);
    expect('refusal' in r && r.refusal.stderr).toContain('agentbox tools add terraform');
    expect('refusal' in r && r.refusal.stderr).toContain('agentbox-ctl tool request terraform');
  });

  it('returns a granted tool', async () => {
    const r = await resolveToolGrant('terraform', '/repo', loader([grant()]));
    expect('grant' in r && r.grant.bin).toBe('terraform');
  });

  it('refuses to route the built-in gh grant through the generic proxy', async () => {
    // gh keeps its own relay handler (branch injection, the gh api endpoint
    // allowlist); silently downgrading it here would drop those guards.
    const r = await resolveToolGrant(
      'gh',
      '/repo',
      loader([grant({ name: 'gh', bin: 'gh', source: 'builtin' })]),
    );
    expect('refusal' in r && r.refusal.exitCode).toBe(65);
    expect('refusal' in r && r.refusal.stderr).toContain('its own relay path');
  });

  it('fails closed when the grant loader throws', async () => {
    const r = await resolveToolGrant('terraform', '/repo', () => {
      throw new Error('unreadable');
    });
    expect('refusal' in r && r.refusal.exitCode).toBe(65);
  });
});

describe('tools.request.enabled gate', () => {
  it('defaults to enabled', async () => {
    await expect(toolRequestsEnabled('/repo', async () => ({ effective: {} }))).resolves.toBe(true);
  });

  it('honors an explicit false', async () => {
    await expect(
      toolRequestsEnabled('/repo', async () => ({
        effective: { tools: { request: { enabled: false } } },
      })),
    ).resolves.toBe(false);
  });

  it('fails closed when the config does not load', async () => {
    await expect(
      toolRequestsEnabled('/repo', () => {
        throw new Error('bad yaml');
      }),
    ).resolves.toBe(false);
  });
});

describe('tool.list rendering', () => {
  it('renders a table for humans', () => {
    const out = renderToolList([grant(), grant({ name: 'aws', bin: 'aws', deny: ['x'] })]);
    expect(out).toContain('aws');
    expect(out).toContain('terraform');
    expect(out).toContain('1 deny');
  });

  it('says so when nothing is granted', () => {
    expect(renderToolList([])).toContain('no host tools granted');
  });

  it('json form drops built-ins (the daemon must not symlink gh)', () => {
    const json = renderToolListJson([grant(), grant({ name: 'gh', bin: 'gh', source: 'builtin' })]);
    expect(JSON.parse(json)).toEqual({ tools: [{ name: 'terraform', bin: 'terraform' }] });
  });
});

describe('host binary readiness', () => {
  beforeEach(() => {
    _resetHostBinReadyCacheForTests();
  });

  // Regression: readiness used to run `<bin> --version` and propagate a
  // non-zero exit as "not ready". Plenty of real CLIs reject that flag
  // (`sw_vers`, `tar`, many subcommand-style tools), so a perfectly usable
  // tool was blocked with its own usage error. Readiness is existence.
  it('accepts a binary that does not support --version', async () => {
    await expect(assertHostBinReady('sh')).resolves.toBeNull();
  });

  it('reports a missing binary as exit 127', async () => {
    const r = await assertHostBinReady('definitely-not-a-real-binary-xyz');
    expect(r?.exitCode).toBe(127);
    expect(r?.stderr).toContain('not installed on the host');
  });
});
