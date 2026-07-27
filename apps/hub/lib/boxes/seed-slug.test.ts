import { describe, expect, it } from 'vitest';
// The canonical derivation. Safe to import here (tests aren't bundled by Next),
// unlike seed-slug.ts itself, which inlines a copy to avoid pulling this
// execa-carrying package into the seed route's standalone bundle.
import { projectSlugFromOriginUrl } from '@agentbox/sandbox-core';
import { custodyIdentityFromRegistration, seedSlugFor } from './seed-slug';

/*
 * Regression guard for the embedded/self-hosted control box: a synthetic project
 * built from a box registration MUST resolve its custody slug, or the seed panel
 * renders empty even when custody holds the seed. We test the exact composition
 * `hub-backend.ts` uses — the registration → project mapping, then `seedSlugFor`.
 */
describe('a project built from a registration resolves its seed slug', () => {
  it('via the projectSlug the box registered with', () => {
    const proj = custodyIdentityFromRegistration({ projectSlug: 'acme__widgets' });
    expect(seedSlugFor(proj)).toBe('acme__widgets');
  });

  it('via origin-URL derivation when no slug was registered', () => {
    const proj = custodyIdentityFromRegistration({ originUrl: 'git@github.com:acme/widgets.git' });
    expect(seedSlugFor(proj)).toBe('acme__widgets');
    const https = custodyIdentityFromRegistration({
      originUrl: 'https://github.com/acme/widgets.git',
    });
    expect(seedSlugFor(https)).toBe('acme__widgets');
  });

  it('prefers the registered slug over the origin URL', () => {
    const proj = custodyIdentityFromRegistration({
      projectSlug: 'acme__widgets',
      originUrl: 'git@github.com:acme/something-else.git',
    });
    expect(seedSlugFor(proj)).toBe('acme__widgets');
  });

  it('is null when the registration carries no git identity', () => {
    // A box with neither a slug nor an origin (e.g. no remote) — the panel hides
    // rather than guessing.
    expect(seedSlugFor(custodyIdentityFromRegistration({}))).toBeNull();
    expect(custodyIdentityFromRegistration({})).toEqual({ originUrl: null, projectSlug: null });
  });

  it('carries both fields through undefineds as explicit nulls', () => {
    // The synthetic project omitting these fields was the original bug; the
    // mapping must always produce them, never leave them undefined.
    expect(
      custodyIdentityFromRegistration({ originUrl: undefined, projectSlug: undefined }),
    ).toEqual({
      originUrl: null,
      projectSlug: null,
    });
  });

  // seed-slug.ts inlines the slug derivation (it can't import the execa-carrying
  // @agentbox/sandbox-core barrel in the seed route's bundle). This pins the copy
  // to the canonical projectSlugFromOriginUrl so the two can never drift.
  it('derives origin slugs identically to the canonical sandbox-core impl', () => {
    for (const url of [
      'git@github.com:acme/widgets.git',
      'https://github.com/acme/widgets',
      'ssh://git@github.com/acme/widgets.git',
      'https://gitlab.com/team/sub/repo.git',
      'git@github.com:Acme/Wid gets.git',
      'not a url',
      '',
    ]) {
      expect(seedSlugFor(custodyIdentityFromRegistration({ originUrl: url }))).toBe(
        projectSlugFromOriginUrl(url),
      );
    }
  });
});
