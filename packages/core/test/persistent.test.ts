import { describe, expect, it } from 'vitest';
import {
  PERSISTENT_UNSUPPORTED,
  persistentRefusal,
  resolveCreatePersistent,
} from '../src/persistent.js';

describe('persistentRefusal', () => {
  it('refuses e2b and vercel by name, with the session cap as the reason', () => {
    for (const provider of ['e2b', 'vercel']) {
      const msg = persistentRefusal(provider);
      expect(msg).toContain(provider);
      expect(msg).toContain('session cap');
    }
  });

  it('allows every provider with no platform session cap', () => {
    for (const provider of ['docker', 'hetzner', 'digitalocean', 'remote-docker', 'daytona']) {
      expect(persistentRefusal(provider)).toBeNull();
    }
  });

  it('allows an unknown (plugin) provider rather than guessing', () => {
    expect(persistentRefusal('islo')).toBeNull();
  });

  it('names an alternative provider that is not itself refused', () => {
    const msg = persistentRefusal('e2b') ?? '';
    const suggested = msg.slice(msg.indexOf('Use a provider')).match(/[a-z-]+/g) ?? [];
    for (const name of Object.keys(PERSISTENT_UNSUPPORTED)) {
      expect(suggested).not.toContain(name);
    }
  });
});

describe('resolveCreatePersistent', () => {
  const service = { caps: { surface: 'service' } } as Parameters<
    typeof resolveCreatePersistent
  >[0]['spec'];
  const tui = { caps: { surface: 'tui' } } as Parameters<typeof resolveCreatePersistent>[0]['spec'];

  it('defaults a SERVICE agent to an always-on box', () => {
    expect(resolveCreatePersistent({ spec: service })).toBe(true);
  });

  it('has no opinion for a TUI agent or for no agent at all', () => {
    // undefined, NOT false: false would override a user's `box.persistent`.
    expect(resolveCreatePersistent({ spec: tui })).toBeUndefined();
    expect(resolveCreatePersistent({})).toBeUndefined();
  });

  it('lets an explicit flag win in both directions', () => {
    expect(resolveCreatePersistent({ spec: service, flag: false })).toBe(false);
    expect(resolveCreatePersistent({ spec: tui, flag: true })).toBe(true);
  });

  it('derives from the surface, not from an agent id', () => {
    // A brand-new service agent gets the default from its registry row alone —
    // nothing here knows the name 'openclaw'.
    const brandNew = { caps: { surface: 'service' } } as typeof service;
    expect(resolveCreatePersistent({ spec: brandNew })).toBe(true);
  });
});
