import { describe, expect, it } from 'vitest';
import { PERSISTENT_UNSUPPORTED, persistentRefusal } from '../src/persistent.js';

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
