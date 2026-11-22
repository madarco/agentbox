import { describe, expect, it } from 'vitest';
import { custodyIdentityFromRegistration, seedSlugsFor } from './seed-slug';

/*
 * Regression guard for the embedded/self-hosted control box: a synthetic project
 * built from a box registration MUST resolve its custody slugs, or the seed panel
 * renders empty even when custody holds the seed. We test the exact composition
 * `hub-backend.ts` uses — the registration → project mapping, then `seedSlugsFor`.
 */
describe('a project built from a registration resolves its seed slugs', () => {
  it('via the projectSlug the box registered with', () => {
    const proj = custodyIdentityFromRegistration({ projectSlug: 'acme__widgets' });
    expect(seedSlugsFor(proj)).toEqual(['acme__widgets']);
  });

  it('via origin-URL derivation: key-derived slug first, legacy owner__repo after', () => {
    const proj = custodyIdentityFromRegistration({ originUrl: 'git@github.com:Acme/widgets.git' });
    expect(seedSlugsFor(proj)).toEqual(['github.com__acme__widgets', 'Acme__widgets']);
    const https = custodyIdentityFromRegistration({
      originUrl: 'https://github.com/acme/widgets.git',
    });
    expect(seedSlugsFor(https)).toEqual(['github.com__acme__widgets', 'acme__widgets']);
  });

  it('tries the origin-derived slug before a (possibly legacy) registered one', () => {
    const proj = custodyIdentityFromRegistration({
      projectSlug: 'acme__widgets',
      originUrl: 'git@github.com:acme/widgets.git',
    });
    expect(seedSlugsFor(proj)).toEqual(['github.com__acme__widgets', 'acme__widgets']);
  });

  it('is empty when the registration carries no git identity', () => {
    expect(seedSlugsFor(custodyIdentityFromRegistration({}))).toEqual([]);
    expect(custodyIdentityFromRegistration({})).toEqual({ originUrl: null, projectSlug: null });
  });

  it('carries both fields through undefineds as explicit nulls', () => {
    expect(
      custodyIdentityFromRegistration({ originUrl: undefined, projectSlug: undefined }),
    ).toEqual({
      originUrl: null,
      projectSlug: null,
    });
  });
});
